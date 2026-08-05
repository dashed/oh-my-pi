Shared task board for the agent team of this session. Every agent (main + all subagents) reads and writes the same board, stored at ~/.omp/teams/<root-session>/tasks/.

Ops:
- list: show board tasks, newest context first: id, title, status, claimedBy, unresolved blockers. Optional status filter.
- create: publish a task (title required; description and blockedBy optional). blockedBy lists task ids that must complete before this task becomes claimable. Returns the new task id.
- claim: atomically claim a pending task for yourself (taskId). Fails with a conflict if another agent already claimed it, or as blocked while any blockedBy prerequisite is not done.
- complete: mark your claimed task done (taskId, optional result). Only the claiming agent can complete a task. Clears the task from every dependent's blockedBy so they become claimable.
- release: give up your claimed task (taskId), returning it to pending for someone else. Only the claiming agent can release a task.

Workflow: create or list to find pending work, claim before starting (exactly one agent wins a claim), complete with a result when done. Check list again after completing — completed prerequisites unblock dependent tasks.
