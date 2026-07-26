/**
 * Serializes a string array as a Postgres array-literal text value (e.g.
 * `{"a","b"}`) for binding into `= ANY(${...}::text[])`. The RDS Data API
 * has no array Field type -- a bare JS array marshals as a JSON string
 * (`["a","b"]`), which `ANY()` rejects ("op ANY/ALL (array) requires array
 * on right side") -- a real-Aurora-only failure invisible locally (PGlite's
 * driver binds JS arrays natively).
 */
export function pgTextArray(values: readonly string[]): string {
  const escaped = values.map(v => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}
