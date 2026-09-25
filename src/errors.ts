/**
 * Engine error with a stable machine-readable code. Every public core API throws EngineError for
 * expected failures (unknown ids, invalid input, render/ffmpeg problems), so adapters such as the
 * MCP server can pass the code through unchanged.
 */
import type { ValidationIssue } from "./scene/validate.js";

export type EngineErrorCode =
  | "WORKSPACE_NOT_FOUND" | "WORKSPACE_EXISTS" | "WORKSPACE_FORBIDDEN" | "INVALID_ID" | "PATH_OUTSIDE_WORKSPACE"
  | "ASSET_NOT_FOUND" | "ASSET_EXISTS" | "INVALID_ASSET" | "LIBRARY_NOT_FOUND" | "FILE_NOT_FOUND"
  | "SCENE_NOT_FOUND" | "SCENE_EXISTS" | "LAYER_NOT_FOUND" | "INVALID_PARENT" | "PARENT_CYCLE"
  | "INVALID_KEYFRAME" | "TRACK_NOT_FOUND" | "INVALID_FRAME" | "UNSUPPORTED_PROPERTY" | "VALIDATION_FAILED"
  | "ARTIFACT_NOT_FOUND" | "RENDER_NOT_FOUND" | "RENDER_FAILED" | "RENDER_CANCELLED" | "RENDER_INTERRUPTED"
  | "CLIP_NOT_FOUND" | "BONE_NOT_FOUND" | "MORPH_NOT_FOUND" | "BLENDER_UNAVAILABLE"
  | "CHARACTER_NOT_FOUND" | "CHARACTER_EXISTS" | "ACTION_NOT_SUPPORTED" | "ACTION_CONFLICT" | "INVALID_ACTION" | "ACTION_NOT_FOUND" | "ACTION_OUT_OF_RANGE" | "SPEECH_NOT_FOUND"
  | "FFMPEG_FAILED" | "ENGINE_CAPABILITY_UNAVAILABLE" | "INVALID_ARGUMENT" | "PROCESSING_FAILED" | "INTERNAL_ERROR";

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Maps validator issue codes to the stable public error code of the whole failed request.
 * The first error decides; all issues stay available in details.issues.
 */
const ISSUE_TO_ERROR: Record<string, EngineErrorCode> = {
  MISSING_PARENT: "INVALID_PARENT",
  PARENT_POINT_WITHOUT_PARENT: "INVALID_PARENT",
  MISSING_ATTACHMENT_POINT: "INVALID_PARENT",
  PARENT_CYCLE: "PARENT_CYCLE",
  MISSING_ASSET: "ASSET_NOT_FOUND",
  MISSING_ASSET_FILE: "ASSET_NOT_FOUND",
  MISSING_TARGET: "LAYER_NOT_FOUND",
  MISSING_LAYER: "LAYER_NOT_FOUND",
  MISSING_TRACK: "TRACK_NOT_FOUND",
  MISSING_KEYFRAME: "INVALID_KEYFRAME",
  DUPLICATE_KEYFRAME: "INVALID_KEYFRAME",
  INVALID_KEYFRAME_VALUE: "INVALID_KEYFRAME",
  INVALID_INTERPOLATION: "INVALID_KEYFRAME",
  MISSING_BEZIER: "INVALID_KEYFRAME",
  UNSUPPORTED_PROPERTY: "UNSUPPORTED_PROPERTY",
  UNKNOWN_PROPERTY: "UNSUPPORTED_PROPERTY",
  CLIP_NOT_FOUND: "CLIP_NOT_FOUND",
  BONE_NOT_FOUND: "BONE_NOT_FOUND",
  MORPH_NOT_FOUND: "MORPH_NOT_FOUND",
  INVALID_ASSET: "INVALID_ASSET",
  CHARACTER_NOT_FOUND: "CHARACTER_NOT_FOUND",
  ACTION_NOT_SUPPORTED: "ACTION_NOT_SUPPORTED",
  ACTION_CONFLICT: "ACTION_CONFLICT",
  INVALID_ACTION: "INVALID_ACTION",
  ACTION_NOT_FOUND: "ACTION_NOT_FOUND",
  ACTION_OUT_OF_RANGE: "ACTION_OUT_OF_RANGE",
  SPEECH_NOT_FOUND: "SPEECH_NOT_FOUND",
};

export function errorFromIssues(issues: ValidationIssue[], context: Record<string, unknown> = {}): EngineError {
  const errors = issues.filter((i) => i.severity === "error");
  const first = errors[0] ?? issues[0];
  let code: EngineErrorCode = ISSUE_TO_ERROR[first?.code ?? ""] ?? "VALIDATION_FAILED";
  // keyframe-level schema problems (bad frame, bad interpolation) are keyframe errors
  if (code === "VALIDATION_FAILED" && first?.path.some((p) => p === "keyframes" || p === "keyframe" || p === "operations")) {
    code = "INVALID_KEYFRAME";
  }
  const message = errors.length > 1 ? `${first.message} (+${errors.length - 1} more issue${errors.length > 2 ? "s" : ""})` : first?.message ?? "Validation failed";
  return new EngineError(code, message, { ...context, issues: errors.map(({ severity: _s, ...rest }) => rest) });
}
