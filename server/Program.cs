using System.Security.Cryptography;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using ClinicalRecords;
using Npgsql;

var workerMode = args.Contains("--worker");
var builder = WebApplication.CreateBuilder(args.Where(arg => arg != "--worker").ToArray());
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 11 * 1024 * 1024);
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
    options.MultipartBodyLengthLimit = 11 * 1024 * 1024);
builder.Services.AddSingleton(NpgsqlDataSource.Create(
    builder.Configuration["POSTGRES"] ?? throw new InvalidOperationException("POSTGRES is required.")));
builder.Services.AddSingleton(new BlobContainerClient(
    builder.Configuration["BLOB_CONNECTION"] ?? throw new InvalidOperationException("BLOB_CONNECTION is required."), "documents"));
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton<Extraction>();
if (workerMode) builder.Services.AddHostedService<Worker>();
var app = builder.Build();
await app.Services.GetRequiredService<Store>().Initialize();
await app.Services.GetRequiredService<BlobContainerClient>().CreateIfNotExistsAsync();
app.UseExceptionHandler(handler => handler.Run(async context =>
{
    context.Response.StatusCode = 500;
    await context.Response.WriteAsJsonAsync(new { error = "The request could not be completed. Please try again." });
}));

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
if (!workerMode)
{
    app.MapGet("/api/config", (IConfiguration config) => new
    {
        extraction = string.IsNullOrEmpty(config["OPENAI_API_KEY"]) ? "local" : "openai",
        demo = true
    });
    app.MapGet("/api/sample", () => Results.File(SamplePdf.Create(), "application/pdf", "synthetic-discharge.pdf"));
    app.MapGet("/api/cases", (Store store) => store.Query("""
        SELECT c.id, c.title, c.created_at, count(d.id) AS document_count
        FROM cases c LEFT JOIN documents d ON d.case_id=c.id
        GROUP BY c.id ORDER BY c.created_at DESC
        """));
    app.MapPost("/api/cases", async (NewCase input, Store store) =>
    {
        if (string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 120)
            return Results.BadRequest(new { error = "Enter a case title of 1 to 120 characters." });
        var id = Guid.NewGuid();
        await store.Query("INSERT INTO cases(id,title) VALUES (@id,@title)", ("id", id), ("title", input.Title.Trim()));
        return Results.Created($"/api/cases/{id}", new { id, title = input.Title.Trim() });
    });
    app.MapGet("/api/cases/{caseId:guid}", async (Guid caseId, Store store) =>
    {
        var cases = await store.Query("SELECT id,title,created_at FROM cases WHERE id=@case", ("case", caseId));
        if (cases.Count == 0) return Results.NotFound();
        var documents = await store.Query("""
            SELECT id,name,status,attempts,error,created_at FROM documents
            WHERE case_id=@case ORDER BY created_at
            """, ("case", caseId));
        var facts = await store.Query("""
            SELECT f.*, d.name AS document_name, d.created_at AS uploaded_at
            FROM facts f JOIN documents d ON d.id=f.document_id
            WHERE d.case_id=@case ORDER BY d.created_at, f.page, f.id
            """, ("case", caseId));
        return Results.Ok(new { record = cases[0], documents, facts });
    });
    app.MapPost("/api/cases/{caseId:guid}/documents", async (Guid caseId, HttpRequest request, Store store, BlobContainerClient blobs) =>
    {
        var cases = await store.Query("SELECT id FROM cases WHERE id=@case", ("case", caseId));
        if (cases.Count == 0) return Results.NotFound();
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "Choose a PDF to upload." });
        var form = await request.ReadFormAsync();
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0 || file.Length > 10 * 1024 * 1024)
            return Results.BadRequest(new { error = "Choose a PDF between 1 byte and 10 MB." });
        await using var memory = new MemoryStream();
        await file.CopyToAsync(memory);
        var bytes = memory.ToArray();
        if (bytes.Length < 5 || !bytes.AsSpan(0, 5).SequenceEqual("%PDF-"u8))
            return Results.BadRequest(new { error = "The uploaded file is not a PDF." });
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var key = $"{caseId}/{hash}.pdf";
        // Content addressing makes repeated blob writes safe. A failed DB insert leaves a reusable object.
        memory.Position = 0;
        try
        {
            await blobs.GetBlobClient(key).UploadAsync(memory, new BlobUploadOptions
            {
                HttpHeaders = new BlobHttpHeaders { ContentType = "application/pdf" },
                Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All }
            });
        }
        catch (RequestFailedException ex) when (ex.Status == 409 || ex.Status == 412) { }
        var name = Path.GetFileName(file.FileName.Replace('\\', '/'));
        if (name.Length > 200) name = name[..200];
        var rows = await store.Query("""
            INSERT INTO documents(id,case_id,name,hash,blob_key) VALUES (@id,@case,@name,@hash,@key)
            ON CONFLICT(case_id,hash) DO NOTHING RETURNING id
            """, ("id", Guid.NewGuid()), ("case", caseId), ("name", name), ("hash", hash), ("key", key));
        var duplicate = rows.Count == 0;
        if (duplicate) rows = await store.Query(
            "SELECT id FROM documents WHERE case_id=@case AND hash=@hash", ("case", caseId), ("hash", hash));
        return Results.Ok(new { id = rows[0]["id"], duplicate });
    });
    app.MapGet("/api/cases/{caseId:guid}/documents/{documentId:guid}/file", async
        (Guid caseId, Guid documentId, Store store, BlobContainerClient blobs, HttpResponse response) =>
    {
        var rows = await store.Query("SELECT blob_key FROM documents WHERE id=@id AND case_id=@case",
            ("id", documentId), ("case", caseId));
        if (rows.Count == 0) return Results.NotFound();
        var file = await blobs.GetBlobClient((string)rows[0]["blob_key"]!).DownloadStreamingAsync();
        response.Headers.ContentDisposition = "inline";
        response.Headers.XContentTypeOptions = "nosniff";
        return Results.Stream(file.Value.Content, "application/pdf");
    });
    app.MapPost("/api/cases/{caseId:guid}/documents/{documentId:guid}/retry", async
        (Guid caseId, Guid documentId, Store store) =>
    {
        var rows = await store.Query("""
            UPDATE documents SET status='pending',attempts=0,error=NULL,lease_token=NULL,lease_until=NULL
            WHERE id=@id AND case_id=@case AND status='failed' RETURNING id
            """, ("id", documentId), ("case", caseId));
        return rows.Count == 0 ? Results.Conflict(new { error = "Only failed documents can be retried." }) : Results.Ok();
    });
    app.MapPatch("/api/cases/{caseId:guid}/facts/{factId:guid}", async (Guid caseId, Guid factId, Correction input, Store store) =>
    {
        if (string.IsNullOrWhiteSpace(input.Text) || input.Text.Length > 4000 || input.Revision < 0)
            return Results.BadRequest(new { error = "Enter a fact of 1 to 4,000 characters." });
        return await store.Correct(caseId, factId, input)
            ? Results.Ok()
            : Results.Conflict(new { error = "This fact changed or is unavailable. Refresh before editing." });
    });
    app.MapGet("/api/cases/{caseId:guid}/facts/{factId:guid}/history", (Guid caseId, Guid factId, Store store) =>
        store.Query("""
            SELECT c.previous_text,c.new_text,c.revision,c.created_at FROM corrections c
            JOIN facts f ON f.id=c.fact_id JOIN documents d ON d.id=f.document_id
            WHERE f.id=@id AND d.case_id=@case ORDER BY c.revision DESC
            """, ("id", factId), ("case", caseId)));
    app.Map("/api/{**path}", () => Results.NotFound());
    app.UseDefaultFiles();
    app.UseStaticFiles();
    app.MapFallbackToFile("index.html");
}
await app.RunAsync();
