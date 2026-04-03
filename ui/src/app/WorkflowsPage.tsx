import NodeGraph from '@/components/NodeGraph'

export default function WorkflowsPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-white">Workflows</h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <NodeGraph />
      </div>
    </div>
  )
}
