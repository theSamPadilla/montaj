# @bycrux/editor

Host-agnostic carousel editor for the ByCrux platform. Ships raw TypeScript/TSX source — the consuming application is responsible for transpilation.

The package owns:
- The editor-facing project/slide/element schema (`./schema`)
- The `EditorAdapter` and `EditorTheme` contracts
- All editor UI components (carousel editor, crop, text formatting, overlay preview)
- State management (reducer + mutation queue + `useProjectState`)

**Video editing is not yet included** — that is a future phase. Today the package covers carousel slides only.

---

## Install

The package is published publicly to the npm registry under the `@bycrux` org.

```bash
npm install @bycrux/editor
```

---

## Required consumer configuration

The package ships raw source and uses Tailwind utility classes internally. Consumers must configure three things.

### 1. Tailwind content glob

Add the package source to your Tailwind `content` array so utility classes are not purged:

```ts
// tailwind.config.ts
export default {
  content: [
    './src/**/*.{ts,tsx}',
    'node_modules/@bycrux/editor/src/**/*.{ts,tsx}', // required
  ],
  // ...
}
```

### 2. React deduplication (Vite)

The package lists `react` and `react-dom` as peer dependencies. In a Vite project, deduplicate them to guarantee a single React instance:

```ts
// vite.config.ts
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['@bycrux/editor'],
  },
})
```

### 3. Next.js transpilePackages

For Next.js consumers, add the package to `transpilePackages` so Next's compiler handles the raw TypeScript source:

```ts
// next.config.ts
const nextConfig = {
  transpilePackages: ['@bycrux/editor'],
}
export default nextConfig
```

---

## Usage

### Implementing an EditorAdapter

The editor is host-agnostic. You supply an `EditorAdapter` that wires up your transport, auth, and URL resolution. The interface is generic over your concrete project type `P extends EditorProject`, so host-specific fields survive load→edit→save round-trips at the type level.

**Required methods:**

| Method | Description |
|---|---|
| `loadProject(id)` | Fetch the full project by id |
| `saveProject(id, project)` | Persist the full project |
| `subscribe(id, onFrame)` | Subscribe to live project frames (e.g. SSE); returns unsubscribe |
| `render(id, opts?)` | Start a render; returns `AsyncIterable<RenderEvent>` |
| `resolveImageSrc(element)` | Map an `ImageElement` to a displayable URL |
| `compileOverlay(template)` | Compile a JSX overlay template → `OverlayFactory`; host-supplied (editor carries no overlay runtime / Three.js) |
| `listGlobalOverlays()` | List workspace-wide overlay templates |
| `listSystemOverlays()` | List built-in/system overlay templates |
| `uploadFile(file, projectId?)` | Upload a file; returns a host-resolvable path |
| `fileUrl(path)` | Map a raw host path to a fetchable URL (synchronous) |

**Optional methods:**

| Method | Description |
|---|---|
| `listMedia?(scope)` | List media items in the given scope (`universal` or `project`) |
| `listProfileOverlays?(profileName)` | List overlay templates scoped to a named profile |
| `getInfo?()` | Return host environment info (e.g. `root_skill_path`) |
| `generateImage?(prompt, projectId)` | AI image generation; editor feature-detects presence |

### Rendering the editor

```tsx
import { CarouselEditor } from '@bycrux/editor'
import type { EditorAdapter, EditorProject } from '@bycrux/editor'

// Your adapter wired to your host's transport
const adapter: EditorAdapter = { /* ... */ }

function MyEditorPage() {
  const [project, setProject] = useState<EditorProject | null>(null)

  return project ? (
    <CarouselEditor
      project={project}
      adapter={adapter}
      onProjectChange={setProject}
      theme={myTheme}   // optional — defaults to Montaj dark theme
      slots={mySlots}   // optional — inject host UI into editor slots
    />
  ) : null
}
```

### EditorSlots

The `slots` prop lets you inject host-specific UI into named regions inside the assembled editor:

| Slot | Where it renders |
|---|---|
| `toolbarActions` | Editor toolbar action area |
| `exportActions` | Export / render action area |
| `assetsPanel` | Assets / media panel area |
| `pendingStatus` | Pending/empty view; replaces default "Message your agent" copy (e.g. live agent progress) |

### Generic project type

If your host carries fields beyond `EditorProject`, pass your richer type through the generic:

```ts
interface MyProject extends EditorProject {
  pipelineId: string
  tenantId: string
}

const adapter: EditorAdapter<MyProject> = { /* ... */ }

<CarouselEditor<MyProject>
  project={myProject}
  adapter={adapter}
  onProjectChange={setMyProject}
/>
```

Your extra fields survive the edit cycle without casts.

---

## Notes

- `compileOverlay` is **always host-supplied**. The package carries no overlay runtime, no Three.js, and no Babel compiler. Montaj provides its own `lib/overlay-eval` implementation; Hub-side consumers will supply their own.
- The `./schema` export (`import ... from '@bycrux/editor/schema'`) is the single source of truth for project/slide/element shapes and can be imported independently of the React components.
