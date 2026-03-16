# Workspace Mode Design

Date: 2026-03-16
Project: ShellBeam App
Branch: `feature/remote-desktop-mode`
Status: Draft approved in conversation, written for review

## Summary

ShellBeam will add a new `Workspace` mode for connected hosts. This mode is an additional experience and does not replace the current terminal-first workflow.

The goal is to make remote servers feel more like manageable personal computers while keeping ShellBeam open source, personal-user focused, and CLI-friendly. Workspace should act as a visual shell over existing SSH capabilities, not as an opaque abstraction that hides the command line.

## Product Positioning

### In Scope

- Open source personal server management experience
- A visual workspace for connected remote Linux hosts
- Desktop and mobile support with platform-appropriate presentation
- Faster access to common server management tasks
- Smooth transitions between visual tools and terminal usage

### Out of Scope

- Team collaboration
- RBAC, approval workflows, or enterprise governance
- Shared team vaults
- Enterprise bastion or compliance products
- Replacing the existing terminal experience

## Core Product Decision

Each connected host session has two top-level modes:

- `Terminal`
- `Workspace`

`Workspace` is a new session mode that sits beside the existing terminal view. Users can switch between them at any time. Both modes share the same host context, connection state, vault-backed credentials, and host metadata.

This preserves ShellBeam's current strengths while adding a more approachable and visual server management layer.

## Cross-Platform Experience

Workspace is a single product feature with one shared application model and two presentations:

- Desktop: `Desktop-style Workspace`
- Mobile: `iOS-style Workspace`

The capability set should stay aligned across platforms, but the navigation and visual treatment should follow device expectations.

### Shared Principles

- Same underlying host and session context across platforms
- Same core application set across platforms
- Every visual action should map cleanly to real SSH or SFTP capabilities
- Users should always be able to jump back to `Terminal`
- Visual tools should assist CLI workflows, not replace them

## Information Architecture

### Session Level

For every connected host:

- `Terminal`
- `Workspace`

### Workspace Application Model

The first version of Workspace uses this application set:

- `Overview`
- `Files`
- `Processes`
- `Services`
- `Logs`
- `Terminal`

Planned later:

- `Network`
- `Docker`

Possible future modules:

- `Sites`
- `SSL`
- `Scheduled Tasks`

## Desktop Experience

### Desktop Entry

Within a connected host session, users can switch from `Terminal` to `Workspace`.

### Desktop Layout

- Top bar with host name, connection state, system information, and quick actions
- Left-side application navigation
- Main content area for the active Workspace app
- `Overview` as the default landing screen

### Desktop Interaction Model

- The experience should feel like a remote server desktop or launcher
- It should not imitate a literal desktop operating system with free-floating windows in v1
- Application switching should be simple and immediate
- Terminal remains a first-class destination

### Desktop Overview Structure

The desktop `Overview` screen should combine server status and application entry:

- Top status band with host name, connection state, OS, current time, and uptime
- Core status cards for CPU, memory, disk, load, network, and top alert
- Application launcher area for the main Workspace apps
- Recent activity section
- Recommended actions section

The page should feel like a remote work desktop, not a metrics-heavy dashboard.

## Mobile Experience

### Mobile Entry

Inside a connected host session, mobile users can switch between:

- `Terminal`
- `Workspace`

### Mobile Layout

Mobile Workspace should not mimic a desktop UI. It should feel like a native iOS-style system management app.

The approved homepage structure is:

- Top status cards
- Middle application grid
- Bottom recent activity section

### Mobile Interaction Model

- Strong iOS-native visual language
- Large title style where appropriate
- Card-driven layout
- Hierarchical navigation into each app
- No complex sidebars
- No multi-window model

This keeps mobile efficient while preserving the same app model as desktop.

## P0 Application Boundaries

### Overview

Purpose:

- Present the current host state
- Act as the Workspace launcher
- Show recent activity and suggested next actions

Non-goals:

- Deep operational workflows
- Replacing application-level screens

### Files

Purpose:

- Remote file browsing and manipulation
- Upload, download, rename, delete, and permission visibility
- Feel closer to a file manager than a raw SFTP panel

Integration rules:

- Users can jump from a file or folder to the terminal in the relevant path

Non-goals:

- Full config analysis
- IDE-like editing features in v1

### Processes

Purpose:

- Visual process list
- Search, sort, and inspect resource usage
- Support process termination

Boundary:

- This is for process instances, not service lifecycle management

### Services

Purpose:

- Visual management of `systemd` services
- Show service status
- Start, stop, restart, and manage enablement where available

Boundary:

- This is for service units, not generic processes
- Container-managed workloads are not part of this app in v1

Fallback behavior:

- If the target system does not support `systemd`, show a clear unsupported-state message

### Logs

Purpose:

- View log streams and recent history
- Focus on `journalctl` and direct log file access in v1
- Support search, filtering, copy, and follow behavior

Non-goals:

- Full log analytics platform
- Team-facing audit tooling

### Terminal

Purpose:

- Remain a first-class app and universal escape hatch
- Support one-click jumps from Workspace tools into the CLI context

Rule:

- Workspace should never trap the user away from the terminal

## Recommended Actions

The `Overview` screen should include lightweight guidance. This should be pragmatic and local-first.

Examples:

- Disk usage is high -> open `Files` or `Logs`
- `nginx` is running -> open `Services` or `Logs`
- A known package like Docker is detected -> show `Docker` as a future-compatible recommendation

In v1 this can be rule-based. AI enhancement can come later.

## Design Principles

- Preserve the current ShellBeam console experience
- Add Workspace as an enhancement, not a replacement
- Make remote Linux feel more like a manageable personal system
- Respect platform norms: desktop workbench on desktop, iOS-native feeling on mobile
- Keep app boundaries tight and understandable
- Use visual interfaces to accelerate common tasks while keeping CLI visibility

## Technical Direction

### Reuse Goals

Workspace should build on existing ShellBeam capabilities where possible:

- Existing SSH session context
- Existing SFTP/file capabilities
- Existing command history and activity history
- Existing host metadata and vault-backed credentials

### Implementation Preference

- Reuse current session and host context models
- Add Workspace as a new session-level mode
- Build app modules with clear boundaries so each can evolve independently
- Keep desktop and mobile UI separate at the presentation layer while sharing domain models

## Initial Scope Recommendation

Version 1 should include:

- Session-level `Workspace` mode switch
- Desktop `Overview` screen
- Mobile `Overview` screen
- Launcher model for Workspace apps
- P0 app shells and navigation
- Functional first implementations of:
  - `Overview`
  - `Files`
  - `Processes`
  - `Services`
  - `Logs`
  - `Terminal` handoff

Version 1 should avoid:

- Windowing systems
- Drag-and-drop desktop metaphors
- Enterprise permissions
- Complex plugin systems
- Overly ambitious dashboards

## Open Questions Resolved

- Should Workspace replace the current console? No.
- Should it support mobile? Yes.
- Should mobile imitate desktop? No. It should use an iOS-style presentation.
- Should the first mobile screen be icon-only like the iPhone home screen? No.
- Should Docker be in P0? No. It is a later module.

## Success Criteria

- Users can connect to a host and switch between `Terminal` and `Workspace`
- Desktop users see a clear server-workbench style homepage
- Mobile users see a native-feeling iOS-style server homepage
- The first six Workspace apps have clearly separated responsibilities
- Users can move between visual tools and terminal workflows without friction
- ShellBeam feels more like a personal remote operating environment than a terminal-only SSH client
