export default function Loading() {
  return (
    <main className="min-h-screen px-8 py-10 max-w-6xl mx-auto">
      <div className="h-4 w-32 bg-slate-200 rounded animate-pulse mb-4" />
      <div className="h-8 w-64 bg-slate-200 rounded animate-pulse mb-2" />
      <div className="h-4 w-48 bg-slate-200 rounded animate-pulse mb-8" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-slate-100 border border-line rounded-xl animate-pulse" />
        ))}
      </div>
    </main>
  );
}
