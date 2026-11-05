using Npgsql;
using System.Text.Json;

namespace ClinicalRecords;

public sealed class Store(NpgsqlDataSource source)
{
    public async Task Initialize()
    {
        await using var connection = await source.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using var command = new NpgsqlCommand("""
            SELECT pg_advisory_xact_lock(812734);
            CREATE TABLE IF NOT EXISTS cases (
                id uuid PRIMARY KEY, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS documents (
                id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases,
                name text NOT NULL, hash text NOT NULL, blob_key text NOT NULL,
                status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
                lease_token uuid, lease_until timestamptz, error text,
                created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id, hash)
            );
            CREATE INDEX IF NOT EXISTS documents_jobs ON documents(status, lease_until);
            CREATE TABLE IF NOT EXISTS pages (
                document_id uuid NOT NULL REFERENCES documents, number integer NOT NULL,
                text text NOT NULL, PRIMARY KEY(document_id, number)
            );
            CREATE TABLE IF NOT EXISTS facts (
                id uuid PRIMARY KEY, document_id uuid NOT NULL, page integer NOT NULL,
                kind text NOT NULL, text text NOT NULL, original_text text NOT NULL,
                quote text NOT NULL, provider text NOT NULL, revision integer NOT NULL DEFAULT 0,
                reviewed boolean NOT NULL DEFAULT false,
                FOREIGN KEY(document_id, page) REFERENCES pages(document_id, number)
            );
            CREATE TABLE IF NOT EXISTS corrections (
                id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                fact_id uuid NOT NULL REFERENCES facts, previous_text text NOT NULL, new_text text NOT NULL,
                revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
            );
            """, connection, transaction);
        await command.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    public async Task<List<Dictionary<string, object?>>> Query(string sql, params (string, object)[] parameters)
    {
        await using var command = source.CreateCommand(sql);
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value);
        await using var reader = await command.ExecuteReaderAsync();
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < reader.FieldCount; i++)
                row.Add(reader.GetName(i), reader.IsDBNull(i) ? null : reader.GetValue(i));
            rows.Add(row);
        }
        return rows;
    }

    public async Task<bool> Correct(Guid caseId, Guid factId, Correction input)
    {
        await using var connection = await source.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using var command = new NpgsqlCommand("""
            SELECT f.text, f.revision FROM facts f JOIN documents d ON d.id=f.document_id
            WHERE f.id=@id AND d.case_id=@case FOR UPDATE OF f
            """, connection, transaction);
        command.Parameters.AddWithValue("id", factId);
        command.Parameters.AddWithValue("case", caseId);
        string previous;
        await using (var reader = await command.ExecuteReaderAsync())
        {
            if (!await reader.ReadAsync() || reader.GetInt32(1) != input.Revision)
                return false;
            previous = reader.GetString(0);
        }
        await using var update = new NpgsqlCommand("""
            UPDATE facts SET text=@text, reviewed=true, revision=revision+1 WHERE id=@id;
            INSERT INTO corrections(fact_id, previous_text, new_text, revision)
            VALUES (@id, @previous, @text, @revision);
            """, connection, transaction);
        update.Parameters.AddWithValue("id", factId);
        update.Parameters.AddWithValue("text", input.Text.Trim());
        update.Parameters.AddWithValue("previous", previous);
        update.Parameters.AddWithValue("revision", input.Revision + 1);
        await update.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
        return true;
    }

    public async Task<Job?> Claim()
    {
        // Row locks arbitrate claims. Expired leases are retried after a crashed worker.
        var rows = await Query("""
            WITH candidate AS (
                SELECT id FROM documents
                WHERE attempts < 3 AND (status='pending' OR (status='processing' AND lease_until < now()))
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE documents d SET status='processing', attempts=attempts+1,
                lease_token=@token, lease_until=now()+interval '5 minutes', error=NULL
            FROM candidate c WHERE d.id=c.id
            RETURNING d.id, d.blob_key, d.lease_token
            """, ("token", Guid.NewGuid()));
        if (rows.Count == 0) return null;
        var row = rows[0];
        return new Job((Guid)row["id"]!, (string)row["blob_key"]!, (Guid)row["lease_token"]!);
    }

    public async Task Complete(Job job, string[] pages, IReadOnlyList<ExtractedFact> facts)
    {
        await using var connection = await source.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using var check = new NpgsqlCommand("""
            SELECT id FROM documents WHERE id=@id AND lease_token=@token AND status='processing'
            FOR UPDATE
            """, connection, transaction);
        check.Parameters.AddWithValue("id", job.Id);
        check.Parameters.AddWithValue("token", job.Token);
        if (await check.ExecuteScalarAsync() is null) return;
        for (var i = 0; i < pages.Length; i++)
        {
            await using var insert = new NpgsqlCommand(
                "INSERT INTO pages VALUES (@id,@number,@text)", connection, transaction);
            insert.Parameters.AddWithValue("id", job.Id);
            insert.Parameters.AddWithValue("number", i + 1);
            insert.Parameters.AddWithValue("text", pages[i]);
            await insert.ExecuteNonQueryAsync();
        }
        foreach (var fact in facts)
        {
            await using var insert = new NpgsqlCommand("""
                INSERT INTO facts(id,document_id,page,kind,text,original_text,quote,provider)
                VALUES (@id,@document,@page,@kind,@text,@text,@quote,@provider)
                """, connection, transaction);
            insert.Parameters.AddWithValue("id", Guid.NewGuid());
            insert.Parameters.AddWithValue("document", job.Id);
            insert.Parameters.AddWithValue("page", fact.Page);
            insert.Parameters.AddWithValue("kind", fact.Kind);
            insert.Parameters.AddWithValue("text", fact.Text);
            insert.Parameters.AddWithValue("quote", fact.Quote);
            insert.Parameters.AddWithValue("provider", fact.Provider);
            await insert.ExecuteNonQueryAsync();
        }
        await using var finish = new NpgsqlCommand(
            "UPDATE documents SET status='ready',lease_until=NULL WHERE id=@id", connection, transaction);
        finish.Parameters.AddWithValue("id", job.Id);
        await finish.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    public Task Fail(Job job, string message) => Query("""
        UPDATE documents SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
            error=@error, lease_until=NULL
        WHERE id=@id AND lease_token=@token AND status='processing'
        """, ("error", message), ("id", job.Id), ("token", job.Token));

    public Task ExpireExhausted() => Query("""
        UPDATE documents SET status='failed',error='Processing interrupted. Retry the document.'
        WHERE status='processing' AND attempts >= 3 AND lease_until < now()
        """);
}

public sealed record NewCase(string Title);
public sealed record Correction(string Text, int Revision);
public sealed record Job(Guid Id, string BlobKey, Guid Token);
public sealed record ExtractedFact(int Page, string Kind, string Text, string Quote, string Provider);
