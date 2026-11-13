# Cross-Project Dependencies — Design

**Date:** 2026-11-12
**Issue:** IT-59 (`Show dependencies between issues in different projects`)
**Owner:** Andrew (Bluecore Energy)

## 1. Intent

Bluecore projects frequently depend on work in other Linear projects (for example, a Controls issue blocking a Commissioning issue). Today GanttSmart loads one project at a time and `DependencyArrows` only draws edges when both endpoints exist in the loaded project's DOM, silently hiding cross-project `blocks` / `blocked_by` relationships and schedule violations.

This design surfaces cross-project dependencies directly on the active project's Gantt chart with zero additional Linear API round-trips per project.

## 2. Goals

1. **Zero extra API calls on load.** Fetch full metadata for cross-project `relatedIssue` nodes inside the existing Query 2 (`relations`) batch in `fetchIssues`. Performance stays $O(1)$ regardless of how many projects exist in the workspace.
2. **Ghost rows + full SVG arrows.** Render scheduled external dependencies as distinct ghost rows with their source project badge, SVG arrows in `DependencyArrows`, and schedule violation warnings in `computeDepViolations`.
3. **Inline by default, reorderable like normal rows.** Place each external ghost row inline right above the first local task it blocks (or right below the first local task that blocks it), while letting users move ghost rows up/down via the drag handle or `Alt+↑/↓` and persisting positions in `customOrder`.
4. **Read-only + 1-click jump by default, with toggleable write mode.** Clicking an external row's project badge jumps directly to that project in GanttSmart. An explicit **Edit external** lock/unlock toggle lets coordinators drag external dates or cycle external status inline without switching projects back and forth.
5. **Project KPIs and baselines stay scoped.** `StatsRow` counts/span, filter counts (`filteredCount/totalCount`), `milestones`, and `usePlanningHistory` baselines/change logs remain strictly scoped to the loaded project's own issues.

## 3. Architecture & Data Flow

### 3.1 Data Model (`src/types.ts`)
Extend `Task` with optional cross-project metadata:
- `projectId?: string | null` — Linear project UUID (or `null` for team-only issues with no project).
- `projectName?: string | null` — Display name of the external project (falls back to `'No Project'`).
- `isExternal?: boolean` — `true` for cross-project dependency tasks.
- `isUnscheduledExternal?: boolean` — `true` when the external issue has neither an explicit `dueDate` nor an external `project.targetDate`.

### 3.2 GraphQL Query Expansion (`src/api/linear.ts`)
Expand `relatedIssue` in Query 2 (`fetchIssues`) to request:
- `id`, `identifier`, `title`, `description` (for `start: DD-MM-YY`), `dueDate`, `url`, `priority`, `completedAt`, `canceledAt`, `state { name type }`, `assignee { name }`, `team { id }`, `project { id name targetDate }`.

Processing rules:
- Canceled or duplicate `relatedIssue` nodes continue to be excluded via `isIgnoredIssueState`.
- Issues already present in the current project (`seenUuids.has(id)` or `project?.id === projectId`) are never duplicated as external ghost rows.
- External nodes are deduplicated by `id` across all local issues and accumulate reverse `blocks` / `blockedBy` references to local issues.
- If `dueDate` or `project?.targetDate` exists, the external issue becomes a scheduled `externalTasks` entry (using `isDueImplicit: true` when falling back to `project.targetDate`). Otherwise it is placed in `externalUnscheduledTasks` so `DetailPanel` can still show full context without inventing a fake bar date.

### 3.3 Inline Placement & Reordering (`src/utils/crossProject.ts`)
`mergeTasksWithExternalOrder(localTasks, externalTasks, customOrder)`:
1. Orders local tasks and any external tasks already recorded in `customOrder` according to `customOrder` (appending newly added local tasks afterward, matching `applyCustomOrder`).
2. For each remaining unpositioned external task (sorted deterministically by `sortTasks`):
   - If it blocks one or more tasks in the list, insert it immediately **before** the earliest task it blocks.
   - Otherwise, if it is blocked by one or more tasks in the list, insert it immediately **after** the earliest task that blocks it.
   - Otherwise, append at the end.
3. Moving any row (local or external) via drag-handle or `Alt+↑/↓` records the unified `uuid` order into `localStorage` (`linear_custom_order_<projectId>`), preserving manual ghost row placement across refreshes.

### 3.4 Filtering, Timeline Range, and Violations
- `filterExternalTasks(externalTasks, visibleLocalTasks, filters, showExternal)`:
  - Respects the `showExternal` toggle (`Cross-project` pill in `FilterBar`, enabled by default) and `filters.showCompleted`.
  - Shows an external task whenever it is linked to at least one visible local task in `visibleLocalTasks` (or directly matches `filters.search`), so filtering by assignee/priority preserves the dependency context for matching local tasks.
- `GanttChart` receives `displayTasks` (local + visible external tasks) for timeline range (`chartStart` / `totalDays`), rows, and `DependencyArrows`.
- `computeDepViolations` evaluates `[...filteredLocalTasks, ...scheduledExternalTasks]` so cross-project schedule conflicts trigger both `⚠` warnings and amber dashed arrows even when ghost rows are collapsed/hidden.

### 3.5 Read-Only Default & Write Mode
- By default (`allowExternalEdits = false`), external ghost rows are rendered with subtle ghost styling, a clickable project badge (1-click jump via `selectProject`), non-interactive status indicator, and no date/connection drag handles. Clicking the bar opens `DetailPanel`.
- Users can activate write mode via the **Edit external** toggle in `FilterBar` (or from `DetailPanel`'s external banner). When enabled, external ghost rows support date dragging (`reschedule` / `rescheduleStart`), status cycling (`cycleStatus` with lazy per-team workflow state loading), and dependency creation (`createRelation`).
- `allowExternalEdits` resets to `false` on project switch so external projects remain protected by default.
- `removeRelation` and `createRelation` resolve endpoints across both local and external task lists, allowing cross-project dependencies to be removed cleanly from `DetailPanel` at any time.

### 3.6 `DetailPanel` & `Tooltip`
- `DetailPanel` displays a cross-project banner for external tasks with a `Open <Project>` jump button and an `Unlock editing` / `Editing unlocked` control.
- Dependency chips in `DetailPanel` enrich linked tasks with project name and schedule status (including unscheduled external tasks) and provide a quick jump button for cross-project links.
- `Tooltip` shows a compact project badge on external bars.
