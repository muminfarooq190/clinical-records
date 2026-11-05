using Azure.Storage.Blobs;

namespace ClinicalRecords;

public sealed class Worker(Store store, BlobContainerClient blobs, Extraction extraction, ILogger<Worker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await store.ExpireExhausted();
                var job = await store.Claim();
                if (job is null)
                {
                    await Task.Delay(1500, stoppingToken);
                    continue;
                }
                var file = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid()}.pdf");
                try
                {
                    await blobs.GetBlobClient(job.BlobKey).DownloadToAsync(file, stoppingToken);
                    var (pages, facts) = await extraction.Run(file, stoppingToken);
                    await store.Complete(job, pages, facts);
                }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                {
                    logger.LogWarning("Document {DocumentId} failed with {ErrorType}", job.Id, ex.GetType().Name);
                    var message = ex is InvalidDataException ? ex.Message : "Processing failed. Check worker configuration and retry.";
                    await store.Fail(job, message);
                }
                finally { File.Delete(file); }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                logger.LogError("Worker loop failed with {ErrorType}", ex.GetType().Name);
                await Task.Delay(3000, stoppingToken);
            }
        }
    }
}
