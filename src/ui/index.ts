/**
 * Plan 09 UI barrel — descriptors, view-models, dashboard HTML.
 * Plan 10 enables manage action bar against POSTs.
 */

export {
  COMPRESSOR_CONTROL_UI_DESCRIPTOR,
  COMPRESSOR_UI_FETCH,
  COMPRESSOR_UI_ID,
  COMPRESSOR_UI_PATH,
  registerCompressorControlUi,
  type ControlUiDescriptor,
  type ControlUiRegistrarApi,
} from "./descriptors.ts";

export * from "./view-models.ts";
export {
  dashboardHtmlFromApis,
  emptyDashboardHtml,
  renderDashboardDocument,
  renderDashboardBody,
  DASHBOARD_CONTENT_TYPE,
} from "./dashboard.ts";
export { renderAllWidgets } from "./widgets/render.ts";
