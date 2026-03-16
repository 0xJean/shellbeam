export function WorkspaceServicesApp() {
  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Services</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Systemd Services</h2>
        <p className="mt-1 text-sm text-muted-foreground">Use this space to inspect service health and jump into start, stop, or restart flows.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `systemctl status`</button>
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `systemctl restart`</button>
        <button type="button" className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40">Run `systemctl list-units`</button>
      </div>
    </div>
  )
}
