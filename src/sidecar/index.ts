export {
  encodeRequest,
  decodeResponse,
  assertProtocolInvariants,
  SidecarProtocolError,
  type SidecarCmd,
  type SidecarRequest,
  type SidecarOk,
  type SidecarErr,
  type SidecarResponse,
} from "./protocol.ts";

export {
  SidecarBootError,
  SidecarDeadError,
  SidecarTimeoutError,
  SidecarAppError,
  SidecarProvisionError,
} from "./errors.ts";

export {
  ensureVenv,
  discoverPython,
  projectConfigEnv,
  buildChildEnv,
  defaultVenvDir,
  venvExists,
  engineRoot,
  venvPythonPath,
  readVenvMeta,
} from "./spawn.ts";

export {
  SidecarClient,
  callOrThrow,
  DEFAULT_TIMEOUTS,
  type SidecarClientOptions,
  type SidecarTimeouts,
} from "./client.ts";

export { sidecarDoctorFindings, probeSidecarHealth } from "./doctor-checks.ts";
