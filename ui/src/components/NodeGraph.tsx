import React, { useCallback, useEffect, useState } from 'react'
import ReactFlow, {
  addEdge,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '@/lib/api'
import type { StepParam, StepSchema } from '@/lib/types/schema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

// ── Agent skills — loaded from /api/skills at runtime ─────────────────────────
// Populated by useEffect below; seed with empty so AGENT_SKILL_NAMES stays stable
// until the fetch resolves. Components re-render once skills arrive.
let _skillsCache: { name: string; description: string }[] = []

// ── Layout ────────────────────────────────────────────────────────────────────
let nodeIdCounter = 1
const NODE_GAP_Y = 110
const NODE_GAP_X = 200
const CANVAS_CX  = 300

// ── Custom nodes ──────────────────────────────────────────────────────────────

function StartNode({ data }: NodeProps) {
  const [open, setOpen] = useState(false)
  const description = data.description as string | undefined
  const notes       = data.notes       as string | undefined
  const hasInfo     = !!(description || notes)
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <div style={{
        background: '#4f46e5', border: '1px solid #6366f1', borderRadius: 20,
        padding: '6px 20px', color: '#fff', fontSize: 12, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase', userSelect: 'none',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        Start
        {hasInfo && (
          <span
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
            style={{
              width: 14, height: 14, borderRadius: '50%', background: '#818cf8',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 900, cursor: 'pointer', flexShrink: 0,
              lineHeight: 1, textTransform: 'none', letterSpacing: 0,
            }}
            title="About this workflow"
          >i</span>
        )}
      </div>

      {open && hasInfo && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 'calc(100% + 10px)', left: '50%',
            transform: 'translateX(-50%)',
            background: '#13112b', border: '1px solid #4338ca', borderRadius: 10,
            width: 320, zIndex: 50, pointerEvents: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px 8px', borderBottom: '1px solid #2d2a55',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              About this workflow
            </span>
            <span
              onClick={() => setOpen(false)}
              style={{ fontSize: 14, color: '#6366f1', cursor: 'pointer', lineHeight: 1 }}
            >×</span>
          </div>

          {/* Description */}
          {description && (
            <div style={{ padding: '10px 14px', borderBottom: notes ? '1px solid #1e1b4b' : undefined }}>
              <p style={{ fontSize: 10, fontWeight: 600, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
                Description
              </p>
              <p style={{ fontSize: 12, color: '#c7d2fe', lineHeight: 1.6 }}>
                {description}
              </p>
            </div>
          )}

          {/* Notes */}
          {notes && (
            <div style={{ padding: '10px 14px', background: '#0f0d24' }}>
              <p style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
                Notes
              </p>
              <p style={{ fontSize: 12, color: '#fde68a', lineHeight: 1.6, opacity: 0.85 }}>
                {notes}
              </p>
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#818cf8' }} />
    </div>
  )
}

function StepNode({ data, selected }: NodeProps) {
  const isSkill    = data.isSkill as boolean
                  ?? new Set(_skillsCache.map(s => s.name)).has(data.uses as string)
  const isEncode      = data.schema?.name === 'apply_cuts' || data.uses === 'montaj/apply_cuts'
  const isMaterialize = data.schema?.name === 'materialize_cut' || data.uses === 'montaj/materialize_cut'
  const isPerClip  = data.foreach === 'clips'
  const bg        = selected
    ? (isEncode ? '#292304' : isMaterialize ? '#1e1608' : isSkill ? '#1e1b4b' : '#1e293b')
    : (isEncode ? '#1c1a03' : isMaterialize ? '#161008' : isSkill ? '#1a1740' : '#1f2937')
  const borderCol = selected
    ? (isEncode ? '#f59e0b' : isMaterialize ? '#c07820' : isSkill ? '#818cf8' : '#3b82f6')
    : (isEncode ? '#92400e' : isMaterialize ? '#5a3a10' : isSkill ? '#4338ca' : '#374151')
  const nodeStyle  = {
    background: bg, border: `1px solid ${borderCol}`,
    borderRadius: 8, padding: '8px 14px', minWidth: 160,
    color: '#f3f4f6', cursor: 'pointer', userSelect: 'none' as const,
    position: 'relative' as const,
  }
  return (
    <div style={{ position: 'relative' }}>
      {isPerClip && (
        <>
          <div style={{ ...nodeStyle, position: 'absolute', top: 6, left: 6, right: -6, bottom: -6, opacity: 0.35, pointerEvents: 'none' }} />
          <div style={{ ...nodeStyle, position: 'absolute', top: 3, left: 3, right: -3, bottom: -3, opacity: 0.6, pointerEvents: 'none' }} />
        </>
      )}
      <div style={nodeStyle}>
        <Handle type="target" position={Position.Top} style={{ background: isEncode ? '#d97706' : isMaterialize ? '#a06218' : isSkill ? '#818cf8' : '#6b7280' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: isEncode ? '#fcd34d' : isMaterialize ? '#c9973a' : isSkill ? '#a5b4fc' : '#f3f4f6' }}>{data.label}</div>
          {isEncode && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              background: '#78350f', color: '#fcd34d', borderRadius: 4, padding: '1px 5px',
            }}>encode</span>
          )}
          {isMaterialize && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              background: '#3d2408', color: '#c9973a', borderRadius: 4, padding: '1px 5px',
            }}>writes</span>
          )}
          {isSkill && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              background: '#4338ca', color: '#c7d2fe', borderRadius: 4, padding: '1px 5px',
            }}>Skill</span>
          )}
          {isPerClip && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
              background: '#1e3a2e', color: '#6ee7b7', borderRadius: 4, padding: '1px 5px',
            }}>per clip</span>
          )}
        </div>
        {data.schema?.description && (
          <div style={{
            fontSize: 11, color: isEncode ? '#d97706' : isMaterialize ? '#8a5a18' : isSkill ? '#6366f1' : '#9ca3af', marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
          }}>
            {data.schema.description}
          </div>
        )}
        <Handle type="source" position={Position.Bottom} style={{ background: isEncode ? '#d97706' : isMaterialize ? '#a06218' : isSkill ? '#818cf8' : '#6b7280' }} />
      </div>
    </div>
  )
}

function DeletableEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow()
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: selected ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
          className="nodrag nopan group"
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.opacity = '1' }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.opacity = selected ? '1' : '0' }}
        >
          <button
            onClick={() => setEdges(eds => eds.filter(e => e.id !== id))}
            style={{
              width: 18, height: 18, borderRadius: '50%',
              background: '#374151', border: '1px solid #6b7280',
              color: '#9ca3af', fontSize: 12, lineHeight: 1,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ef4444'; (e.currentTarget as HTMLButtonElement).style.color = '#fff' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#374151'; (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af' }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { start: StartNode, step: StepNode }
const edgeTypes = { deletable: DeletableEdge }

// ── Topological sort ──────────────────────────────────────────────────────────

function topoSort(nodes: Node[], edges: Edge[]): Node[] {
  const inDeg = new Map(nodes.map(n => [n.id, 0]))
  const adj   = new Map(nodes.map(n => [n.id, [] as string[]]))
  for (const e of edges) {
    adj.get(e.source)?.push(e.target)
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
  }
  const queue  = nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0)
  const sorted: Node[] = []
  while (queue.length) {
    const n = queue.shift()!
    sorted.push(n)
    for (const next of adj.get(n.id) ?? []) {
      const d = (inDeg.get(next) ?? 1) - 1
      inDeg.set(next, d)
      if (d === 0) { const nx = nodes.find(x => x.id === next); if (nx) queue.push(nx) }
    }
  }
  const seen = new Set(sorted.map(n => n.id))
  return [...sorted, ...nodes.filter(n => !seen.has(n.id))]
}

// ── Inline param fields ───────────────────────────────────────────────────────

function ParamField({ param, value, onChange }: {
  param: StepParam
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (param.type === 'bool') return (
    <div className="flex items-center gap-2">
      <Switch
        checked={Boolean(value ?? param.default ?? false)}
        onCheckedChange={onChange}
      />
      <Label className="text-xs">{param.name}</Label>
    </div>
  )

  if (param.type === 'enum') return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-xs">{param.name}</Label>
      <Select
        value={String(value ?? param.default ?? '')}
        onChange={e => onChange(e.target.value)}
        options={(param.options ?? []).map(o => ({ value: o, label: o }))}
      />
    </div>
  )

  if (param.type === 'int' || param.type === 'float') return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-xs">
        {param.name}{param.required && <span className="text-red-400 ml-0.5">*</span>}
      </Label>
      <Input
        type="number"
        step={param.type === 'float' ? 'any' : '1'}
        min={param.min} max={param.max}
        placeholder={String(param.default ?? '')}
        value={value !== undefined ? String(value) : ''}
        className="h-7 text-xs"
        onChange={e => {
          if (e.target.value === '') { onChange(undefined); return }
          const n = param.type === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
          if (!isNaN(n)) onChange(n)
        }}
      />
    </div>
  )

  return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-xs">
        {param.name}{param.required && <span className="text-red-400 ml-0.5">*</span>}
      </Label>
      <Input
        type="text"
        placeholder={String(param.default ?? '')}
        value={String(value ?? '')}
        className="h-7 text-xs"
        onChange={e => onChange(e.target.value)}
      />
      {param.description && <p className="text-xs text-gray-500">{param.description}</p>}
    </div>
  )
}

// ── Workflow types ────────────────────────────────────────────────────────────

interface WorkflowStep {
  id: string
  uses: string
  needs?: string[]
  foreach?: string
  params?: Record<string, unknown>
}

interface WorkflowFile {
  name: string
  description?: string
  notes?: string
  steps: WorkflowStep[]
}

// ── Module-level sentinel (stable across renders) ─────────────────────────────
const NEW_WF = '__new__'

// ── Start node factory ────────────────────────────────────────────────────────
function makeStartNode(description?: string, notes?: string): Node {
  return {
    id: 'start',
    type: 'start',
    position: { x: CANVAS_CX - 40, y: 40 },
    data: { description, notes },
    deletable: false,
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NodeGraph() {
  const [steps,          setSteps]          = useState<StepSchema[]>([])
  const [skills,         setSkills]         = useState<{ name: string; description: string; scope: 'native' | 'custom' }[]>([])
  const [workflows,      setWorkflows]      = useState<{ name: string; scope: 'user' | 'builtin' }[]>([])
  const [activeWorkflow, setActiveWorkflow] = useState<string>('')
  const [nodes, setNodes, onNodesChange]    = useNodesState([])
  const [edges, setEdges, onEdgesChange]    = useEdgesState([])
  const [selectedNode,   setSelectedNode]   = useState<Node | null>(null)
  const [paramValues,    setParamValues]    = useState<Record<string, Record<string, unknown>>>({})
  const [workflowName,   setWorkflowName]   = useState('my-workflow')
  const [saveMsg,        setSaveMsg]        = useState<string | null>(null)
  const [loadErr,        setLoadErr]        = useState<string | null>(null)
  const [activeScope,    setActiveScope]    = useState<'user' | 'builtin' | null>(null)
  const [activeDesc,     setActiveDesc]     = useState<string | undefined>(undefined)
  const [isDirty,        setIsDirty]        = useState(false)
  const [isDark,         setIsDark]         = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark'))
    )
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    api.listSteps().then(setSteps).catch(console.error)
    api.listSkills().then(s => { setSkills(s); _skillsCache = s }).catch(console.error)
    api.listWorkflows().then(wfs => {
      setWorkflows(wfs)
      if (wfs.length > 0) {
        const sorted = [...wfs].sort((a, b) => a.name.localeCompare(b.name))
        setActiveWorkflow(sorted[0].name)
      }
    }).catch(console.error)
  }, [])

  // When "New workflow" is selected, reset the canvas to just the Start node
  useEffect(() => {
    if (activeWorkflow !== NEW_WF) return
    setNodes([makeStartNode()])
    setEdges([])
    setSelectedNode(null)
    setParamValues({})
    setWorkflowName('my-workflow')
    setActiveScope(null)
    setActiveDesc(undefined)
    setIsDirty(false)
    nodeIdCounter = 10
  }, [activeWorkflow])

  // Load a named workflow whenever the selection or steps list changes
  useEffect(() => {
    if (!activeWorkflow || activeWorkflow === NEW_WF) return
    if (!steps.length || !workflows.length || !skills.length) return
    setLoadErr(null)
    const meta = workflows.find(w => w.name === activeWorkflow)
    setActiveScope(meta?.scope ?? null)
    api.getWorkflow(activeWorkflow)
      .then(wf => {
        const wfFile = wf as unknown as WorkflowFile
        setActiveDesc(wfFile.description)
        setIsDirty(false)
        loadWorkflow(wfFile, wfFile.notes)
      })
      .catch(err => {
        setLoadErr(err instanceof Error ? err.message : 'Failed to load workflow')
        console.error(err)
      })
  }, [activeWorkflow, steps, workflows, skills])

  function resolveSchema(uses: string): StepSchema | undefined {
    const name = uses.replace(/^(montaj|user|\.\/steps)\//, '')
    return steps.find(s => s.name === name)
  }

  function loadWorkflow(wf: WorkflowFile, notes?: string) {
    const newNodes: Node[] = []
    const newEdges: Edge[] = []

    newNodes.push(makeStartNode(wf.description, notes))

    // Build step id → node id map for edge resolution
    const stepToNodeId = new Map<string, string>()
    wf.steps.forEach((step, i) => stepToNodeId.set(step.id, `wf-${i}-${step.id}`))

    // Assign ranks via longest-path from Start (so parallel steps share a rank)
    const rankMap = new Map<string, number>()
    wf.steps.forEach((step, i) => {
      const id = `wf-${i}-${step.id}`
      if (!step.needs?.length) {
        rankMap.set(id, 1)
      } else {
        const maxNeedsRank = Math.max(...step.needs.map(needId => {
          const nid = stepToNodeId.get(needId)
          return nid ? (rankMap.get(nid) ?? 0) : 0
        }))
        rankMap.set(id, maxNeedsRank + 1)
      }
    })

    // Group node ids by rank for horizontal distribution
    const rankGroups = new Map<number, string[]>()
    wf.steps.forEach((step, i) => {
      const id = `wf-${i}-${step.id}`
      const rank = rankMap.get(id) ?? 1
      if (!rankGroups.has(rank)) rankGroups.set(rank, [])
      rankGroups.get(rank)!.push(id)
    })

    wf.steps.forEach((step, i) => {
      const schema = resolveSchema(step.uses)
      const id = `wf-${i}-${step.id}`
      const rank = rankMap.get(id) ?? 1
      const group = rankGroups.get(rank) ?? [id]
      const indexInGroup = group.indexOf(id)
      const groupSize = group.length

      newNodes.push({
        id,
        type: 'step',
        position: {
          x: CANVAS_CX - 80 + (indexInGroup - (groupSize - 1) / 2) * NODE_GAP_X,
          y: 40 + rank * NODE_GAP_Y,
        },
        data: {
          label: skillNameSet.has(step.uses) ? step.uses : (schema?.name ?? step.id),
          schema: schema ?? skills.find(s => s.name === step.uses) ?? { name: step.uses, description: step.uses },
          uses: step.uses,
          foreach: step.foreach,
          stepId: step.id,
          isSkill: skillNameSet.has(step.uses),
        },
      })

      if (!step.needs?.length) {
        newEdges.push({ id: `e-start-${id}`, source: 'start', target: id, type: 'deletable' })
      } else {
        step.needs.forEach(needId => {
          const srcId = stepToNodeId.get(needId)
          if (srcId) newEdges.push({ id: `e-${srcId}-${id}`, source: srcId, target: id, type: 'deletable' })
        })
      }

      // Pre-populate params defined in the workflow file
      if (step.params && schema) {
        setParamValues(prev => ({
          ...prev,
          [schema.name]: { ...(prev[schema.name] ?? {}), ...step.params },
        }))
      }
    })

    nodeIdCounter = wf.steps.length + 10
    setNodes(newNodes)
    setEdges(newEdges)
    setSelectedNode(null)
  }

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges(eds => addEdge({ ...params, type: 'deletable' }, eds)),
    [setEdges],
  )

  function addNode(schema: StepSchema) {
    const id = `node-${nodeIdCounter++}`
    setNodes(nds => [...nds, {
      id,
      type: 'step',
      position: {
        x: CANVAS_CX - 80 + (Math.random() * 60 - 30),
        y: 40 + nds.length * NODE_GAP_Y,
      },
      data: { label: schema.name, schema },
    }])
  }

  function onNodeClick(_evt: React.MouseEvent, node: Node) {
    if (node.type === 'start') { setSelectedNode(null); return }
    setSelectedNode(node)
  }

  async function handleSave() {
    const isExisting = activeWorkflow !== NEW_WF
    const name = isExisting ? activeWorkflow : (workflowName.trim() || 'my-workflow')
    const description = isExisting ? (activeDesc ?? '') : 'Saved from montaj UI'
    const exportNodes = nodes.filter(n => n.type !== 'start')
    const sorted = topoSort(exportNodes, edges)
    const workflow = {
      name,
      description,
      steps: sorted.map((node) => {
        const schema = node.data.schema as StepSchema
        const params = paramValues[schema?.name]
        const stepId = (node.data.stepId as string) ?? schema?.name ?? node.id
        const needs = edges
          .filter(e => e.target === node.id && e.source !== 'start')
          .map(e => {
            const src = nodes.find(n => n.id === e.source)
            return (src?.data.stepId as string) ?? (src?.data.schema as StepSchema)?.name ?? e.source
          })
        return {
          id: stepId,
          uses: `montaj/${schema?.name ?? node.id}`,
          ...(needs.length ? { needs } : {}),
          ...(params && Object.keys(params).length ? { params } : {}),
        }
      }),
    }
    try {
      await api.saveWorkflow(name, workflow)
      setSaveMsg(`Saved workflows/${name}.json`)
      setIsDirty(false)
      if (activeScope === 'builtin') setActiveScope('user')
      setWorkflows(prev =>
        prev.some(w => w.name === name)
          ? prev
          : [...prev, { name, scope: 'user' as const }].sort((a, b) => a.name.localeCompare(b.name))
      )
      setActiveWorkflow(name)
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Save failed')
    }
    setTimeout(() => setSaveMsg(null), 3000)
  }

  const selectedSchema = selectedNode?.data.schema as StepSchema | undefined
  const skillNameSet = new Set(skills.map(s => s.name))

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-52 shrink-0 border-r border-gray-200 dark:border-gray-800 overflow-y-auto p-2 flex flex-col gap-3">

        {/* Workflow loader */}
        <div className="flex flex-col gap-1.5 pb-2 border-b border-gray-200 dark:border-gray-800">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Workflow</p>
          <select
            value={activeWorkflow}
            onChange={e => setActiveWorkflow(e.target.value)}
            className="text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-gray-900 dark:text-gray-200 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500"
          >
            <option value={NEW_WF}>＋ New workflow</option>
            {['user', 'builtin'].map(scope => {
              const group = workflows.filter(w => w.scope === scope)
              if (!group.length) return null
              return (
                <optgroup key={scope} label={scope === 'user' ? 'My workflows' : 'Built-in'}>
                  {group.map(w => (
                    <option key={w.name} value={w.name}>{w.name}</option>
                  ))}
                </optgroup>
              )
            })}
          </select>
          {loadErr && <p className="text-xs text-red-400">{loadErr}</p>}
        </div>

        {/* Save controls — new workflow or user workflow only */}
        {(activeWorkflow === NEW_WF || activeScope === 'user') && (
          <div className="flex flex-col gap-1.5 pb-2 border-b border-gray-200 dark:border-gray-800">
            {activeWorkflow === NEW_WF && (
              <Input
                value={workflowName}
                onChange={e => setWorkflowName(e.target.value)}
                placeholder="workflow name"
                className="text-xs h-7"
              />
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={nodes.filter(n => n.type !== 'start').length === 0}
            >
              Save workflow
            </Button>
            {saveMsg && <p className="text-xs text-green-400">{saveMsg}</p>}
          </div>
        )}

        {/* Step palette */}
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Steps</p>
          {[...steps].sort((a, b) => a.name.localeCompare(b.name)).map(s => {
            const isCustom = s.name.includes('/')
            const isEncode = s.name === 'apply_cuts'
            const isMat    = s.name === 'materialize_cut'
            return (
              <button
                key={s.name}
                onClick={() => addNode(s)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-between gap-1 ${
                  isEncode ? 'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-200'
                  : isMat ? 'text-orange-700 dark:text-orange-500/80 hover:text-orange-800 dark:hover:text-orange-300'
                  : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <span className="truncate">{s.name}</span>
                <span className={`shrink-0 text-[9px] font-bold px-1 py-0.5 rounded ${
                  isCustom
                    ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-400'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}>
                  {isCustom ? 'C' : 'N'}
                </span>
              </button>
            )
          })}
          {steps.length === 0 && <p className="text-xs text-gray-600">No steps found.</p>}
        </div>

        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Skills</p>
          {skills.map(s => {
            const isCustom = s.scope === 'custom'
            return (
              <button
                key={s.name}
                onClick={() => addNode(s)}
                title={s.description}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 hover:text-indigo-800 dark:hover:text-indigo-100 flex items-center justify-between gap-1"
              >
                <span className="truncate">{s.name}</span>
                <span className={`shrink-0 text-[9px] font-bold px-1 py-0.5 rounded ${
                  isCustom
                    ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-400'
                    : 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400'
                }`}>
                  {isCustom ? 'C' : 'N'}
                </span>
              </button>
            )
          })}
          {skills.length === 0 && <p className="text-xs text-gray-600">No skills found.</p>}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        {isDirty && activeScope === 'builtin' && (
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
            <Button size="sm" onClick={handleSave}>
              Fork &amp; save
            </Button>
            {saveMsg && <p className="text-xs text-green-400 bg-gray-900/80 rounded px-1.5 py-0.5">{saveMsg}</p>}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes) => { onNodesChange(changes); if (changes.some(c => c.type === 'add' || c.type === 'remove')) setIsDirty(true) }}
          onEdgesChange={(changes) => { onEdgesChange(changes); if (changes.some(c => c.type !== 'select')) setIsDirty(true) }}
          onConnect={(c) => { onConnect(c); setIsDirty(true) }}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelectedNode(null)}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={isDark ? '#374151' : '#d1d5db'} gap={20} />
          <Controls />
          <MiniMap nodeColor={isDark ? '#1f2937' : '#e5e7eb'} maskColor={isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'} />
        </ReactFlow>
      </div>

      {/* Step config panel */}
      {selectedSchema && (() => {
        const isSelectedSkill = skillNameSet.has(selectedSchema.name)
        const isEncode = selectedNode?.data.uses === 'montaj/apply_cuts' ||
                         selectedNode?.data.schema?.name === 'apply_cuts'
        const isMaterialize = selectedNode?.data.uses === 'montaj/materialize_cut' ||
                              selectedNode?.data.schema?.name === 'materialize_cut'
        return (
          <div className="w-60 shrink-0 border-l border-gray-200 dark:border-gray-800 p-3 overflow-y-auto flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className={`text-sm font-semibold ${isEncode ? 'text-amber-600 dark:text-amber-300' : isMaterialize ? 'text-orange-700 dark:text-orange-400/80' : isSelectedSkill ? 'text-indigo-600 dark:text-indigo-300' : 'text-gray-900 dark:text-white'}`}>
                  {selectedSchema.name}
                </h3>
                {isEncode && (
                  <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-900/60 text-amber-400 rounded px-1.5 py-0.5">
                    encode
                  </span>
                )}
                {isMaterialize && (
                  <span className="text-[9px] font-bold uppercase tracking-wide bg-orange-900/40 text-orange-400/80 rounded px-1.5 py-0.5">
                    writes
                  </span>
                )}
                {isSelectedSkill && (
                  <span className="text-[9px] font-bold uppercase tracking-wide bg-indigo-900 text-indigo-300 rounded px-1.5 py-0.5">
                    Skill
                  </span>
                )}
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-lg leading-none"
              >
                ×
              </button>
            </div>
            {selectedSchema.description && (
              <p className={`text-xs leading-relaxed ${isEncode ? 'text-amber-700 dark:text-amber-200/70' : isMaterialize ? 'text-orange-700 dark:text-orange-300/60' : isSelectedSkill ? 'text-indigo-600 dark:text-indigo-200/70' : 'text-gray-500 dark:text-gray-400'}`}>
                {selectedSchema.description}
              </p>
            )}
            {isEncode && (
              <div style={{
                background: '#1c1a03', border: '1px solid #92400e', borderRadius: 6,
                padding: '8px 10px', fontSize: 11, color: '#fcd34d', lineHeight: 1.5,
              }}>
                ⚡ Encode boundary — the only step that writes video. Receives trim specs from upstream steps and applies all cuts to original sources in one pass.
              </div>
            )}
            {isMaterialize && (
              <div style={{
                background: '#160f06', border: '1px solid #5a3a10', borderRadius: 6,
                padding: '8px 10px', fontSize: 11, color: '#c9973a', lineHeight: 1.5,
              }}>
                ✂️ Writes files — applies editor cuts to produce new clip assets on disk.
              </div>
            )}
            {isSelectedSkill ? (
              <p className="text-[10px] text-indigo-400/50 italic">
                Agent-authored — no configurable params. Execution is driven by the agent at runtime.
              </p>
            ) : (selectedSchema.params?.length ?? 0) > 0 ? (
              <div className="flex flex-col gap-3">
                {selectedSchema.params!.map(param => (
                  <ParamField
                    key={param.name}
                    param={param}
                    value={(paramValues[selectedSchema.name] ?? {})[param.name]}
                    onChange={v =>
                      setParamValues(prev => ({
                        ...prev,
                        [selectedSchema.name]: {
                          ...(prev[selectedSchema.name] ?? {}),
                          [param.name]: v,
                        },
                      }))
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500">No configurable params.</p>
            )}
          </div>
        )
      })()}
    </div>
  )
}
