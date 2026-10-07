// Job lifecycle: the states a job may move to from each state.
export const JOB_FLOW = {
  queued:    ["running", "cancelled"],
  running:   ["done", "failed"],
  done:      [],
  failed:    [],
  cancelled: [],
};
