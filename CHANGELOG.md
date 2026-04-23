# Changelog

## v0.2.0

### AI Video Generation
- Full AI video pipeline: storyboarding, scene-level generation, and regeneration via Kling connector
- Character and environment reference image support for multi-shot consistency
- Parallel scene generation with credentials helper
- `ai_video` workflow and dedicated skill

### Connectors
- Connector framework for external AI APIs (Kling, Gemini, OpenAI)
- Gemini connector with inline image analysis
- Kling connector with multi-shot support

### Music & Voiceover
- Music generation pipeline and step
- Voiceover generation step
- Audio track support with waveform visualization in timeline

### Lyrics Video
- Lyrics video workflows with audio support
- `lyrics_render` and `lyrics_sync` steps
- Caption step for subtitle generation

### Engine & Render
- Timeline refactored to unified `tracks` array architecture
- Deterministic type codegen from schemas
- Hardcoded render color schema corrected
- Fixed image 404 on Puppeteer when filenames contained spaces

### UI
- AI-generated project conditional intake UI
- Storyboard view for AI-generated projects
- Mixed floating head + normal video support
- Audio track waveform visualization in timeline

### CLI & Infrastructure
- Steps reorganized into subdirectories (`audio/`, `edit/`, `generate/`, `lyrics/`, `media/`, `speech/`, `transform/`)
- Project type foundations and schema updates
- PyPI release preparation (`pyproject.toml`, `MANIFEST.in`, entry points)
- CLI utility fixes and copy command improvements

## v0.1.0

Initial release — CLI-first video editing toolkit with trim-spec architecture, render engine (ffmpeg + Puppeteer/JSX), browser UI, and MCP server.
