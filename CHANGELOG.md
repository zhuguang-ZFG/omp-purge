# Changelog

## 0.3.0 — omp native port

- Ported from [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge) to `@oh-my-pi/pi-coding-agent`.
- Package manifest now declares `omp.extensions`; peer dependency targets omp.
- `before_agent_start` handles omp's `string[]` system prompt and returns `string[]`.
- `strict` reads the working directory from `ExtensionContext.cwd` with `process.cwd()` fallback.
- `replace` strips omp's current identity line and the `omp://` docs bullet, with pi's old anchors kept as fallback.
- Added `/purge reload`; `OMP_PURGE_SOURCE` added, `PI_PURGE_SOURCE` still honored.
- Tests rewritten around the omp prompt shape.
