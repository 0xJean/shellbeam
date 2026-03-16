export function WorkspaceFilesApp() {
  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Files</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Remote Files</h2>
        <p className="mt-1 text-sm text-muted-foreground">Browse remote paths visually, then drop back to the terminal when you need precision.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-border/60 bg-card/70 p-4 text-sm text-muted-foreground">
          SFTP-powered file navigation will live here.
        </div>
        <button
          type="button"
          className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40"
        >
          Open in Terminal
        </button>
      </div>
    </div>
  )
}
