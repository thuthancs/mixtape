import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createContext, useCallback, useContext, useState } from 'react';
import { generate, getClips, SunoApiError, type Clip, type GenerateBody } from './api';

type ParamValue = string | boolean;

type ParamData = {
  value: ParamValue;
};

type SongData = {
  clipId?: string;
  status?: string;
  audioUrl?: string;
  title?: string;
  imageUrl?: string;
  error?: string;
};

type FlowContextValue = {
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
};

const FlowContext = createContext<FlowContextValue | null>(null);

function useFlowContext(): FlowContextValue {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error('useFlowContext must be used within FlowContext.Provider');
  return ctx;
}

const POLL_INTERVAL_MS = 5000;

const PARAM_CONFIG: Record<string, { label: string; placeholder: string }> = {
  topic: { label: 'Topic', placeholder: 'e.g. A rock anthem about hackathon innovation' },
  tags: { label: 'Tags', placeholder: 'e.g. rock, electric guitar, anthem' },
  prompt: { label: 'Custom lyrics', placeholder: '[Verse]\\nYour lyrics here...' },
  instrumental: { label: 'Instrumental only', placeholder: '' },
};

function ParamNode({ id, data, type }: NodeProps<Node<ParamData>>) {
  const paramType = type as string;
  const config = PARAM_CONFIG[paramType] ?? { label: paramType, placeholder: '' };
  const { setNodes } = useFlowContext();
  const isInstrumental = paramType === 'instrumental';
  const value = (data as ParamData).value;
  const textValue = typeof value === 'string' ? value : '';
  const boolValue = typeof value === 'boolean' ? value : false;

  const handleChange = useCallback(
    (newValue: ParamValue) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, value: newValue } } : n))
      );
    },
    [id, setNodes]
  );

  const nodeStyle = {
    padding: '12px',
    borderRadius: '8px',
    background: 'white',
    border: '1px solid #1a192b',
    minWidth: '200px',
  };

  if (isInstrumental) {
    return (
      <div style={nodeStyle}>
        <Handle type="target" position={Position.Top} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={boolValue}
            onChange={(e) => handleChange(e.target.checked)}
            aria-label={config.label}
          />
          {config.label}
        </label>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  const isMultiline = paramType === 'prompt';
  return (
    <div style={nodeStyle}>
      <Handle type="target" position={Position.Top} />
      <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
        {config.label}
      </label>
      {isMultiline ? (
        <textarea
          value={textValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={config.placeholder}
          rows={3}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
          aria-label={config.label}
        />
      ) : (
        <input
          value={textValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={config.placeholder}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            boxSizing: 'border-box',
          }}
          aria-label={config.label}
        />
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function SongNode({ id, data }: NodeProps<Node<SongData>>) {
  const d = data as SongData;
  const { nodes, edges, setNodes } = useFlowContext();
  const [isGenerating, setIsGenerating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreateError(null);
    const incomingEdges = edges.filter((e) => e.target === id);
    const sourceIds = [...new Set(incomingEdges.map((e) => e.source))];
    const paramNodes = nodes.filter((n) => sourceIds.includes(n.id));

    const body: GenerateBody = { make_instrumental: false };
    for (const node of paramNodes) {
      const paramData = node.data as ParamData;
      const val = paramData?.value;
      const nodeType = node.type as string;
      if (nodeType === 'topic' && typeof val === 'string' && val.trim()) body.topic = val.trim();
      if (nodeType === 'tags' && typeof val === 'string' && val.trim()) body.tags = val.trim();
      if (nodeType === 'prompt' && typeof val === 'string' && val.trim()) body.prompt = val.trim();
      if (nodeType === 'instrumental' && val === true) body.make_instrumental = true;
    }

    if (!body.topic && !body.prompt) {
      setCreateError('Connect a Topic or Custom lyrics node and enter a value');
      return;
    }

    setIsGenerating(true);
    setNodes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data as SongData), status: 'submitted', error: undefined } } : n
      )
    );

    try {
      const clip = await generate(body);

      const pollForResult = async (): Promise<Clip> => {
        const clips = await getClips([clip.id]);
        const c = clips[0];
        if (!c) throw new SunoApiError('Clip not found');
        if (c.status === 'streaming' || c.status === 'complete') return c;
        if (c.status === 'error')
          throw new SunoApiError((c.metadata?.error_message as string) ?? 'Generation failed');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        return pollForResult();
      };

      const result = await pollForResult();
      const audioUrl = result.audio_url ?? undefined;
      const title = result.title ?? 'Untitled';
      const imageUrl = result.image_url ?? undefined;

      setNodes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  clipId: result.id,
                  status: result.status,
                  audioUrl,
                  title,
                  imageUrl,
                  error: undefined,
                },
              }
            : n
        )
      );
    } catch (e) {
      const msg =
        e instanceof SunoApiError ? e.message : e instanceof Error ? e.message : 'Generation failed';
      setCreateError(msg);
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, data: { ...(n.data as SongData), error: msg } } : n))
      );
    } finally {
      setIsGenerating(false);
    }
  }, [id, nodes, edges, setNodes]);

  if (d.error) {
    return (
      <div
        style={{
          padding: '12px',
          borderRadius: '8px',
          background: '#fff5f5',
          border: '1px solid #feb2b2',
          minWidth: '220px',
        }}
      >
        <Handle type="target" position={Position.Top} />
        <div style={{ fontSize: '14px', color: '#c53030', marginBottom: '8px' }}>{d.error}</div>
        <button
          onClick={handleCreate}
          disabled={isGenerating}
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: '14px',
            fontWeight: 600,
            background: isGenerating ? '#ccc' : '#1a192b',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: isGenerating ? 'not-allowed' : 'pointer',
          }}
        >
          {isGenerating ? 'Generating...' : 'Create'}
        </button>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  if (d.status === 'submitted' || d.status === 'queued') {
    return (
      <div
        style={{
          padding: '12px',
          borderRadius: '8px',
          background: '#f7fafc',
          border: '1px solid #1a192b',
          minWidth: '220px',
        }}
      >
        <Handle type="target" position={Position.Top} />
        <div style={{ fontSize: '14px' }}>Generating...</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  if (!d.audioUrl) {
    const hasConnections = edges.some((e) => e.target === id);
    return (
      <div
        style={{
          padding: '12px',
          borderRadius: '8px',
          background: 'white',
          border: '1px solid #1a192b',
          minWidth: '220px',
        }}
      >
        <Handle type="target" position={Position.Top} />
        <div style={{ fontSize: '13px', color: '#718096', marginBottom: '8px' }}>
          {hasConnections
            ? 'Connect parameter nodes, then click Create'
            : 'Connect parameter nodes (Topic, Tags, etc.) and click Create'}
        </div>
        {createError && <div style={{ fontSize: '12px', color: '#c00', marginBottom: '8px' }}>{createError}</div>}
        <button
          onClick={handleCreate}
          disabled={isGenerating}
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: '14px',
            fontWeight: 600,
            background: isGenerating ? '#ccc' : '#1a192b',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: isGenerating ? 'not-allowed' : 'pointer',
          }}
        >
          {isGenerating ? 'Generating...' : 'Create'}
        </button>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '12px',
        borderRadius: '8px',
        background: 'white',
        border: '1px solid #1a192b',
        minWidth: '280px',
      }}
    >
      <Handle type="target" position={Position.Top} />
      {d.imageUrl && (
        <img
          src={d.imageUrl}
          alt=""
          style={{
            width: '100%',
            borderRadius: '6px',
            marginBottom: '8px',
            maxHeight: '120px',
            objectFit: 'cover',
          }}
        />
      )}
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>{d.title || 'Untitled'}</div>
      <audio src={d.audioUrl} controls style={{ width: '100%', height: '36px', marginBottom: '8px' }} aria-label="Play generated song" />
      <button
        onClick={handleCreate}
        disabled={isGenerating}
        style={{
          width: '100%',
          padding: '6px 12px',
          fontSize: '13px',
          fontWeight: 600,
          background: isGenerating ? '#ccc' : '#1a192b',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          cursor: isGenerating ? 'not-allowed' : 'pointer',
        }}
      >
        {isGenerating ? 'Generating...' : 'Recreate'}
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = {
  topic: ParamNode,
  tags: ParamNode,
  prompt: ParamNode,
  instrumental: ParamNode,
  song: SongNode,
};

const initialNodes: Node[] = [
  { id: 'topic-1', type: 'topic', position: { x: 0, y: 0 }, data: { value: '' } },
  { id: 'tags-1', type: 'tags', position: { x: 0, y: 80 }, data: { value: '' } },
  { id: 'song-output', type: 'song', position: { x: 0, y: 280 }, data: {} },
];

const initialEdges: Edge[] = [];

function FlowWithContext() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((prev) => applyNodeChanges(changes, prev)),
    []
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((prev) => applyEdgeChanges(changes, prev)),
    []
  );
  const onConnect = useCallback((params: Connection) => setEdges((prev) => addEdge(params, prev)), []);

  const addParamNode = useCallback(
    (type: 'topic' | 'tags' | 'prompt' | 'instrumental') => {
      const id = `${type}-${Date.now()}`;
      const lastOfType = nodes.filter((n) => n.type === type).pop();
      const baseY = lastOfType?.position.y ?? 0;
      const newNode: Node = {
        id,
        type,
        position: { x: 0, y: baseY + 80 },
        data: type === 'instrumental' ? { value: false } : { value: '' },
      };
      setNodes((prev) => [...prev, newNode]);
    },
    [nodes, setNodes]
  );

  return (
    <FlowContext.Provider value={{ nodes, edges, setNodes, setEdges }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <Panel position="top-left" style={{ display: 'flex', gap: '8px', margin: '10px' }}>
          <button
            onClick={() => addParamNode('topic')}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              background: '#1a192b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            + Topic
          </button>
          <button
            onClick={() => addParamNode('tags')}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              background: '#1a192b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            + Tags
          </button>
          <button
            onClick={() => addParamNode('prompt')}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              background: '#1a192b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            + Lyrics
          </button>
          <button
            onClick={() => addParamNode('instrumental')}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              background: '#1a192b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            + Instrumental
          </button>
        </Panel>
      </ReactFlow>
    </FlowContext.Provider>
  );
}

export default function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <FlowWithContext />
    </div>
  );
}
