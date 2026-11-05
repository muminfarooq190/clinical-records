export type Case = { id: string; title: string; created_at: string; document_count: number };
export type Document = { id: string; name: string; status: string; error: string | null; attempts: number; created_at: string };
export type Fact = { id: string; document_id: string; document_name: string; page: number; kind: string; text: string; original_text: string; quote: string; provider: string; revision: number; reviewed: boolean; uploaded_at: string };
export type Detail = { record: Case; documents: Document[]; facts: Fact[] };
export type Change = { previous_text: string; new_text: string; revision: number; created_at: string };
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed. Please try again.');
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
