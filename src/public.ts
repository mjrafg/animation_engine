/** Stable library API. Scene schema remains version 1; breaking changes require a major release. */
export { AnimationEngine, type RenderVideoOptions } from './api/engine.js';
export { EngineSession, TOOLS, toolDefinitions, type ToolName, type ToolResult } from './api/tools.js';
export { validateScene, SceneValidationError, type ValidationIssue, type ValidationResult, type ValidateOptions } from './scene/validate.js';
export * from './scene/schema.js';
export { prepareVideoAsset, type PrepareVideoOptions } from './media/prepare.js';
export { subtitlesFromTiming, type TimingBlock, type SubtitlesTimingOptions, type SubtitleCue } from './subtitles/timing.js';
export { mediaCapabilities, type SubtitleOptions } from './subtitles/encode.js';
export { SpeechTimingSchema, type SpeechTiming } from './characters/schema.js';
