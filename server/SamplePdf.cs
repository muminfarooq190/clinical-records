using System.Text;

namespace ClinicalRecords;

public static class SamplePdf
{
    public static byte[] Create()
    {
        string[] lines =
        [
            "SYNTHETIC RECORD - FOR SOFTWARE DEMONSTRATION",
            "Patient: Alex Example | Case: DEMO-001",
            "Document: Discharge summary | Date: 2026-01-15",
            "Reason for admission: Evaluation of persistent fatigue.",
            "Procedure: Blood sample collected on 2026-01-14.",
            "Medication: Example medicine A listed in discharge notes.",
            "Follow-up: Outpatient review documented for 2026-01-22.",
            "This fictional record is not medical guidance."
        ];
        var content = "BT /F1 12 Tf 50 760 Td 22 TL\n" +
            string.Join("\n", lines.Select(line => $"({line}) Tj T*")) + "\nET";
        string[] objects =
        [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            $"<< /Length {Encoding.ASCII.GetByteCount(content)} >>\nstream\n{content}\nendstream"
        ];
        var pdf = new StringBuilder("%PDF-1.4\n");
        var offsets = new List<int> { 0 };
        for (var i = 0; i < objects.Length; i++)
        {
            offsets.Add(pdf.Length);
            pdf.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }
        var xref = pdf.Length;
        pdf.Append($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (var offset in offsets.Skip(1)) pdf.Append($"{offset:D10} 00000 n \n");
        pdf.Append($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return Encoding.ASCII.GetBytes(pdf.ToString());
    }
}
