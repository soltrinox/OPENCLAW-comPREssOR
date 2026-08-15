/** Fail-open for the host: throw so EngineHost can quarantine. */

export class SidecarBootError extends Error {
  readonly code = "sidecar_boot";
  constructor(message: string) {
    super(message);
    this.name = "SidecarBootError";
  }
}

export class SidecarDeadError extends Error {
  readonly code = "sidecar_dead";
  constructor(message: string) {
    super(message);
    this.name = "SidecarDeadError";
  }
}

export class SidecarTimeoutError extends Error {
  readonly code = "sidecar_timeout";
  constructor(message: string) {
    super(message);
    this.name = "SidecarTimeoutError";
  }
}

export class SidecarAppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SidecarAppError";
    this.code = code;
  }
}

export class SidecarProvisionError extends Error {
  readonly code = "sidecar_provision";
  readonly pipTail: string;
  constructor(message: string, pipTail = "") {
    super(message);
    this.name = "SidecarProvisionError";
    this.pipTail = pipTail;
  }
}
