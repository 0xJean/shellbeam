import type { ComponentType, ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { WorkspacePanelHeader } from './workspace-panel-header'

export interface WorkspaceResourceGroup {
  key: string
  label: ReactNode
  count: number
  colorClassName: string
}

export interface WorkspaceResourceMetric {
  key: string
  label: ReactNode
  value: ReactNode
  icon?: ComponentType<{ className?: string }>
}

export interface WorkspaceResourceHeaderTab {
  key: string
  label: ReactNode
  icon?: ComponentType<{ className?: string }>
  disabled?: boolean
}

export interface WorkspaceResourceOverviewHeaderProps {
  preheader?: ReactNode
  tabs?: WorkspaceResourceHeaderTab[]
  activeTab?: string
  onTabChange?: (tab: string) => void
  tabsPlacement?: 'actions' | 'preheader' | 'summary'
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  total: number
  totalLabel: ReactNode
  totalMeta?: ReactNode
  visibleCount?: number
  visibleLabel?: ReactNode
  groups?: WorkspaceResourceGroup[]
  selectedGroup?: string
  allGroupKey?: string
  allGroupLabel?: ReactNode
  onGroupSelect?: (group: string) => void
  search?: ReactNode
  controls?: ReactNode
  metrics?: WorkspaceResourceMetric[]
  children?: ReactNode
  className?: string
  preheaderClassName?: string
  headerClassName?: string
  actionsClassName?: string
  contentClassName?: string
  summaryClassName?: string
  tabsClassName?: string
}

export function WorkspaceResourceOverviewHeader({
  preheader,
  tabs,
  activeTab,
  onTabChange,
  tabsPlacement = 'actions',
  eyebrow,
  title,
  description,
  note,
  actions,
  total,
  totalLabel,
  totalMeta,
  visibleCount,
  visibleLabel,
  groups = [],
  selectedGroup,
  allGroupKey = 'All',
  allGroupLabel,
  onGroupSelect,
  search,
  controls,
  metrics,
  children,
  className,
  preheaderClassName,
  headerClassName,
  actionsClassName,
  contentClassName,
  summaryClassName,
  tabsClassName,
}: WorkspaceResourceOverviewHeaderProps) {
  const { t } = useT()
  const safeTotal = Math.max(total, 0)
  const showVisibleCount = typeof visibleCount === 'number' && visibleCount !== total
  const showGroups = safeTotal > 0 && groups.length > 0
  const resolvedVisibleLabel = visibleLabel ?? t('workspace.common.matches')
  const resolvedAllGroupLabel = allGroupLabel ?? t('workspace.common.all')
  const groupTabs = showGroups ? [{ key: allGroupKey, label: resolvedAllGroupLabel }, ...groups.map((group) => ({ key: group.key, label: group.label }))] : []
  const hasHeaderTabs = Boolean(tabs?.length)
  const showSummaryTabs = hasHeaderTabs && tabsPlacement === 'summary'
  const showActionTabs = hasHeaderTabs && tabsPlacement === 'actions'
  const tabList = hasHeaderTabs ? (
    <div
      role="tablist"
      className={cn(
        tabsPlacement === 'summary'
          ? 'flex flex-wrap gap-1 rounded-lg bg-[var(--workspace-surface-800)] p-0.5'
          : 'inline-flex rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-1',
        tabsClassName,
      )}
    >
      {tabs?.map((tab) => {
        const Icon = tab.icon
        const active = activeTab === tab.key
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            onClick={() => onTabChange?.(tab.key)}
            className={cn(
              'inline-flex items-center gap-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              tabsPlacement === 'summary' ? 'rounded-md px-3 py-1.5' : 'h-9 rounded-lg px-3',
              active
                ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)] shadow-sm ring-1 ring-[var(--workspace-border-glow)]'
                : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {tab.label}
          </button>
        )
      })}
    </div>
  ) : null
  const resolvedPreheader = hasHeaderTabs && tabsPlacement === 'preheader' ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {tabList}
      {preheader}
    </div>
  ) : preheader
  const resolvedActions = (
    <>
      {showActionTabs && tabList}
      {actions}
    </>
  )

  return (
    <WorkspacePanelHeader
      className={cn('border-b border-[color:var(--workspace-border-strong)] pb-4', className)}
      preheader={resolvedPreheader}
      preheaderClassName={preheaderClassName}
      headerClassName={cn('xl:flex-row xl:items-start xl:justify-between', headerClassName)}
      eyebrowClassName="text-[var(--workspace-text-subtle)]"
      titleClassName="text-[var(--workspace-text-strong)]"
      descriptionClassName="text-[var(--workspace-text-muted)]"
      noteClassName="text-[var(--workspace-text-subtle)]"
      eyebrow={eyebrow}
      title={title}
      description={description}
      note={note}
      actions={showActionTabs || actions ? resolvedActions : undefined}
      actionsClassName={cn('justify-start xl:justify-end', actionsClassName)}
      contentClassName={cn('mt-4 space-y-4', contentClassName)}
    >
      <div className={cn('grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] xl:items-start', summaryClassName)}>
        <div className="min-w-0">
          <div className="flex items-end gap-2">
            <span className="text-3xl font-semibold leading-none text-[var(--workspace-text-strong)]">{total}</span>
            <span className="pb-1 text-sm text-[var(--workspace-text-muted)]">{totalLabel}</span>
            {totalMeta && <span className="pb-1">{totalMeta}</span>}
            {showVisibleCount && (
              <span className="pb-1 text-xs text-[var(--workspace-text-subtle)]">{visibleCount} {resolvedVisibleLabel}</span>
            )}
          </div>

          {showGroups && (
            <div className="mt-4 space-y-2">
              <div className="flex h-2 overflow-hidden rounded-full bg-[var(--workspace-meter-track)]">
                {groups.map((group) => (
                  <div
                    key={group.key}
                    className={cn('h-full', group.colorClassName)}
                    style={{ width: `${safeTotal === 0 ? 0 : (group.count / safeTotal) * 100}%` }}
                    title={`${group.label} ${group.count}`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => onGroupSelect?.(selectedGroup === group.key ? allGroupKey : group.key)}
                    disabled={!onGroupSelect}
                    className={cn(
                      'inline-flex items-center gap-1.5 text-xs transition-colors disabled:cursor-default',
                      selectedGroup === group.key
                        ? 'text-[var(--workspace-text-strong)]'
                        : 'text-[var(--workspace-text-muted)]',
                      onGroupSelect && selectedGroup !== group.key && 'hover:text-[var(--workspace-text)]',
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', group.colorClassName)} />
                    <span>{group.label}</span>
                    <span className="font-semibold">{group.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showSummaryTabs && tabList && (
            <div className="mt-4">
              {tabList}
            </div>
          )}

          {!showSummaryTabs && groupTabs.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1 rounded-lg bg-[var(--workspace-surface-800)] p-0.5">
              {groupTabs.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  onClick={() => onGroupSelect?.(group.key)}
                  disabled={!onGroupSelect}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-default',
                    selectedGroup === group.key
                      ? 'bg-[var(--workspace-surface-row-selected)] text-[var(--workspace-accent-text)] shadow-sm ring-1 ring-[var(--workspace-border-glow)]'
                      : 'text-[var(--workspace-text-muted)]',
                    onGroupSelect && selectedGroup !== group.key && 'hover:text-[var(--workspace-text)]',
                  )}
                >
                  {group.label}
                </button>
              ))}
            </div>
          )}

          {search && <div className="mt-4">{search}</div>}
        </div>

        {metrics && metrics.length > 0 && (
          <div className="grid self-start rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-2 shadow-[var(--workspace-shadow-card)] sm:grid-cols-2">
            {metrics.map((metric) => {
              const Icon = metric.icon
              return (
                <div
                  key={metric.key}
                  className="min-w-0 rounded-xl px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {Icon && (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium text-[var(--workspace-text-muted)]">{metric.label}</div>
                      <div className="mt-0.5 truncate font-mono text-base font-semibold leading-none text-[var(--workspace-text-strong)]">
                        {metric.value}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      {children}
    </WorkspacePanelHeader>
  )
}
