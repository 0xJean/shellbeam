export function WorkspaceProcessesApp() {
  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Processes</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Running Processes</h2>
        <p className="mt-1 text-sm text-muted-foreground">A visual process table will land here with common inspection and kill actions.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `top`</button>
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `htop`</button>
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `ps aux`</button>
      </div>
    </div>
  )
}
