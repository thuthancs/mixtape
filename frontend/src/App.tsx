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
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { generate, getClips, separateStems, SunoApiError, type Clip, type GenerateBody } from './api';
import { addComment, fetchComments, type Comment } from './comments';
import { refineMusicPrompt } from './openai';

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

const FRIEND_NAMES = ['Thu', 'Yerkem', 'Rawan'] as const;

const DEFAULT_GRADIENT_COLORS = ['#fce4ec', '#f8bbd9', '#e1bee7', '#b2dfdb', '#b2ebf2', '#c8e6c9'];

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
    }
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  s /= 100;
  l /= 100;
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function lightenForGradient(hex: string, amount = 0.25): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const [h, s, l] = rgbToHsl(r, g, b);
  const newL = Math.min(95, l + amount * 100);
  const newS = Math.min(60, s * 1.2);
  const [nr, ng, nb] = hslToRgb(h, newS, newL);
  return rgbToHex(nr, ng, nb);
}

function extractColorsFromImage(imageUrl: string): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 50;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(DEFAULT_GRADIENT_COLORS);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const colorCounts: Record<string, number> = {};
        for (let i = 0; i < data.length; i += 12) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 128) continue;
          const [, , l] = rgbToHsl(r, g, b);
          if (l < 15 || l > 92) continue;
          const key = `${Math.round(r / 24) * 24},${Math.round(g / 24) * 24},${Math.round(b / 24) * 24}`;
          colorCounts[key] = (colorCounts[key] ?? 0) + 1;
        }
        const sorted = Object.entries(colorCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([key]) => {
            const [r, g, b] = key.split(',').map(Number);
            return lightenForGradient(rgbToHex(r, g, b));
          });
        if (sorted.length >= 3) {
          resolve(sorted);
        } else {
          resolve(DEFAULT_GRADIENT_COLORS);
        }
      } catch {
        resolve(DEFAULT_GRADIENT_COLORS);
      }
    };
    img.onerror = () => resolve(DEFAULT_GRADIENT_COLORS);
    img.src = imageUrl;
  });
}
const AUTHOR_STORAGE_KEY = 'mixtape-comment-author';

const PARAM_CONFIG: Record<string, { label: string; placeholder: string }> = {
  topic: { label: 'Topic', placeholder: 'e.g. A rock anthem about hackathon innovation' },
  tags: { label: 'Tags', placeholder: 'e.g. rock, electric guitar, anthem' },
  prompt: { label: 'Custom lyrics', placeholder: '[Verse]\\nYour lyrics here...' },
  instrumental: { label: 'Instrumental only', placeholder: '' },
  aiPrompt: {
    label: 'Prompt',
    placeholder: 'e.g. chill vibes, something for studying, upbeat workout music',
  },
};

const nodeBaseClasses = 'p-3 rounded-lg bg-white border border-[#1a192b] min-w-[200px]';

const btnPrimaryClasses =
  'w-full py-2 px-3 text-sm font-semibold bg-black text-white border-0 rounded-md cursor-pointer disabled:cursor-not-allowed font-instrument-serif gradient-hover';

const panelBtnClasses =
  'py-1.5 px-3 text-[16px] bg-black text-white border-0 rounded-md cursor-pointer font-instrument-serif gradient-hover';

function ParamNode({ id, data, type }: NodeProps<Node<ParamData>>) {
  const paramType = type as string;
  const config = PARAM_CONFIG[paramType] ?? { label: paramType, placeholder: '' };
  const { setNodes } = useFlowContext();
  const isInstrumental = paramType === 'instrumental';
  const isAiPrompt = paramType === 'aiPrompt';
  const value = (data as ParamData).value;
  const textValue = typeof value === 'string' ? value : '';
  const boolValue = typeof value === 'boolean' ? value : false;
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const minRows = paramType === 'prompt' ? 3 : paramType === 'aiPrompt' ? 2 : 1;

  const handleChange = useCallback(
    (newValue: ParamValue) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, value: newValue } } : n))
      );
      setRefineError(null);
    },
    [id, setNodes]
  );

  const handleRefine = useCallback(async () => {
    setRefining(true);
    setRefineError(null);
    try {
      const refined = await refineMusicPrompt(textValue);
      handleChange(refined);
    } catch (e) {
      setRefineError(e instanceof Error ? e.message : 'Failed to refine prompt');
    } finally {
      setRefining(false);
    }
  }, [textValue, handleChange]);

  useEffect(() => {
    if (isInstrumental) return;
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(ta.scrollHeight, minRows * 20)}px`;
    }
  }, [textValue, minRows, isInstrumental]);

  if (isInstrumental) {
    return (
      <div className={nodeBaseClasses}>
        <Handle type="target" position={Position.Top} />
        <label className="flex items-center gap-2 text-[13px]">
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

  return (
    <div className={nodeBaseClasses}>
      <Handle type="target" position={Position.Top} />
      <label className="text-xs font-semibold block mb-1.5">{config.label}</label>
      <textarea
        ref={textareaRef}
        value={textValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={config.placeholder}
        rows={minRows}
        wrap="soft"
        className="w-full py-1.5 text-[13px] border-0 outline-none bg-transparent resize-none overflow-hidden box-border font-instrument-sans"
        aria-label={config.label}
      />
      {isAiPrompt && (
        <>
          {refineError && (
            <div className="text-xs text-red-600 mt-1 font-instrument-sans">{refineError}</div>
          )}
          <button
            type="button"
            onClick={handleRefine}
            disabled={refining}
            className="mt-2 text-[12px] font-instrument-serif text-[#1a192b] underline cursor-pointer hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
          >
            {refining ? 'Refining...' : 'Refine with AI'}
          </button>
        </>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function SongNode({ id, data }: NodeProps<Node<SongData>>) {
  const d = data as SongData;
  const { nodes, edges, setNodes, setEdges } = useFlowContext();
  const [isGenerating, setIsGenerating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentContent, setCommentContent] = useState('');
  const [authorName, setAuthorName] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(AUTHOR_STORAGE_KEY);
      return stored && FRIEND_NAMES.includes(stored as (typeof FRIEND_NAMES)[number])
        ? stored
        : FRIEND_NAMES[0];
    } catch {
      return FRIEND_NAMES[0];
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [stems, setStems] = useState<Clip[]>([]);
  const [stemsLoading, setStemsLoading] = useState(false);
  const [stemsError, setStemsError] = useState<string | null>(null);
  const [stemsExpanded, setStemsExpanded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [gradientColors, setGradientColors] = useState<string[]>(DEFAULT_GRADIENT_COLORS);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!d.imageUrl) return;
    extractColorsFromImage(d.imageUrl).then(setGradientColors);
  }, [d.imageUrl]);

  useEffect(() => {
    if (!isPlaying || !cardRef.current) return;
    const card = cardRef.current;
    let rafId: number;
    let phase = 0;
    let lastTime = 0;

    const update = (timestamp: number) => {
      const dt = lastTime ? (timestamp - lastTime) / 1000 : 0.016;
      lastTime = timestamp;
      phase += dt * 1.2;
      if (phase > 1) phase -= 1;
      const x = Math.round(50 + 50 * Math.sin(phase * Math.PI * 2));
      const y = Math.round(50 + 50 * Math.cos(phase * Math.PI * 2));
      card.style.backgroundPosition = `${x}% ${y}%`;
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(rafId);
      card.style.background = '';
      card.style.backgroundSize = '';
      card.style.backgroundPosition = '';
    };
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying || !cardRef.current) return;
    const card = cardRef.current;
    const stops = gradientColors
      .map((c, i) => `${c} ${Math.round((i / Math.max(1, gradientColors.length - 1)) * 100)}%`)
      .join(', ');
    card.style.background = `linear-gradient(135deg, ${stops})`;
    card.style.backgroundSize = '200% 200%';
    return () => {
      if (cardRef.current) {
        cardRef.current.style.background = '';
        cardRef.current.style.backgroundSize = '';
      }
    };
  }, [isPlaying, gradientColors]);

  const handleAuthorChange = useCallback((name: string) => {
    setAuthorName(name);
    try {
      localStorage.setItem(AUTHOR_STORAGE_KEY, name);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!d.clipId) return;
    setCommentsLoading(true);
    fetchComments(d.clipId)
      .then(setComments)
      .finally(() => setCommentsLoading(false));
  }, [d.clipId]);

  const handleAddComment = useCallback(async () => {
    if (!d.clipId || !commentContent.trim()) return;
    setSubmitting(true);
    setPostError(null);
    const result = await addComment(d.clipId, commentContent, authorName);
    if (result.success) {
      setComments((prev) => [...prev, result.data]);
      setCommentContent('');
    } else {
      setPostError(result.error);
    }
    setSubmitting(false);
  }, [d.clipId, commentContent, authorName]);

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const handleSplitStems = useCallback(async () => {
    if (!d.clipId) return;
    setStemsLoading(true);
    setStemsError(null);
    try {
      const stemClips = await separateStems(d.clipId);
      if (stemClips.length === 0) {
        setStemsError('No stems returned');
        return;
      }
      setStems(stemClips);
      const stemIds = stemClips.map((c) => c.id);

      const pollForStems = async (): Promise<Clip[]> => {
        const clips = await getClips(stemIds);
        setStems(clips);
        const completeCount = clips.filter((c) => c.status === 'complete').length;
        const hasError = clips.some((c) => c.status === 'error');
        if (hasError) {
          const failed = clips.find((c) => c.status === 'error');
          throw new SunoApiError(
            (failed?.metadata?.error_message as string) ?? 'Stem separation failed'
          );
        }
        if (completeCount === clips.length) return clips;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        return pollForStems();
      };

      await pollForStems();
      setStemsExpanded(true);
    } catch (e) {
      const msg =
        e instanceof SunoApiError ? e.message : e instanceof Error ? e.message : 'Stem separation failed';
      setStemsError(msg);
    } finally {
      setStemsLoading(false);
    }
  }, [d.clipId]);

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
      if (nodeType === 'aiPrompt' && typeof val === 'string' && val.trim()) body.topic = val.trim();
      if (nodeType === 'tags' && typeof val === 'string' && val.trim()) body.tags = val.trim();
      if (nodeType === 'prompt' && typeof val === 'string' && val.trim()) body.prompt = val.trim();
      if (nodeType === 'instrumental' && val === true) body.make_instrumental = true;
    }

    if (!body.topic && !body.prompt) {
      setCreateError('Connect a Topic, Prompt, or Custom lyrics node and enter a value');
      return;
    }

    setIsGenerating(true);

    const isRecreate = !!d.audioUrl;
    const currentNode = nodes.find((n) => n.id === id);
    const currentPosition = currentNode?.position ?? { x: 0, y: 280 };
    const newSongId = `song-${Date.now()}`;

    if (!isRecreate) {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, data: { ...(n.data as SongData), status: 'submitted', error: undefined } } : n
        )
      );
    }

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

      if (isRecreate) {
        const newSongNode: Node<SongData> = {
          id: newSongId,
          type: 'song',
          position: { x: currentPosition.x + 320, y: currentPosition.y },
          data: {
            clipId: result.id,
            status: result.status,
            audioUrl,
            title,
            imageUrl,
            error: undefined,
          },
        };
        setNodes((prev) => [...prev, newSongNode]);
        const incomingEdges = edges.filter((e) => e.target === id);
        const newEdges = incomingEdges.map((e) => ({
          id: `${e.source}-${newSongId}`,
          source: e.source,
          target: newSongId,
        }));
        setEdges((prev) => {
          const existing = new Set(prev.map((e) => e.id));
          const toAdd = newEdges.filter((e) => !existing.has(e.id));
          return [...prev, ...toAdd];
        });
      } else {
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
      }
    } catch (e) {
      const msg =
        e instanceof SunoApiError ? e.message : e instanceof Error ? e.message : 'Generation failed';
      setCreateError(msg);
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, data: { ...(n.data as SongData), error: msg } } : n
        )
      );
    } finally {
      setIsGenerating(false);
    }
  }, [id, d, nodes, edges, setNodes, setEdges]);

  if (d.error) {
    return (
      <div className="p-3 rounded-lg bg-red-50 border border-red-200 min-w-[220px]">
        <Handle type="target" position={Position.Top} />
        <div className="text-sm text-red-600 mb-2 font-instrument-sans">{d.error}</div>
        <button onClick={handleCreate} disabled={isGenerating} className={btnPrimaryClasses}>
          <span className="relative z-10">{isGenerating ? 'Generating...' : 'Create'}</span>
        </button>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  if (d.status === 'submitted' || d.status === 'queued') {
    return (
      <div className="p-3 rounded-lg bg-slate-50 border border-[#1a192b] min-w-[220px] gradient-active">
        <Handle type="target" position={Position.Top} />
        <div className="text-sm font-instrument-serif text-center relative z-10">Generating...</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  if (!d.audioUrl) {
    const hasConnections = edges.some((e) => e.target === id);
    return (
      <div className="p-3 rounded-lg bg-white border border-[#1a192b] min-w-[220px]">
        <Handle type="target" position={Position.Top} />
        <div className="text-[12px] text-gray-500 mb-2 font-instrument-sans">
          {hasConnections
            ? 'Connect parameter nodes, then click Create'
            : 'Connect parameter nodes (Topic, Tags, etc.) and click Create'}
        </div>
        {createError && <div className="text-xs text-red-600 mb-2 font-instrument-sans">{createError}</div>}
        <button onClick={handleCreate} disabled={isGenerating} className={btnPrimaryClasses}>
          <span className="relative z-10">{isGenerating ? 'Generating...' : 'Create'}</span>
        </button>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className={`p-3 rounded-lg border border-[#1a192b] min-w-[280px] transition-colors duration-500 ${
        isPlaying ? 'song-card-playing' : 'bg-white'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      {d.imageUrl && (
        <img src={d.imageUrl} alt="" className="w-full rounded-md mb-2 max-h-[120px] object-cover" />
      )}
      <div className="text-sm font-bold mb-2">{d.title || 'Untitled'}</div>
      <audio
        ref={audioRef}
        src={d.audioUrl}
        controls
        className="w-full h-9 mb-2"
        aria-label="Play generated song"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <button onClick={handleCreate} disabled={isGenerating} className={btnPrimaryClasses}>
        <span className="relative z-10">{isGenerating ? 'Generating...' : 'Recreate'}</span>
      </button>
      {d.clipId && (
        <button
          onClick={handleSplitStems}
          disabled={stemsLoading}
          className="w-full mt-2 py-2 px-3 text-sm font-instrument-serif border border-[#1a192b] rounded-md cursor-pointer hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {stemsLoading
            ? `Separating stems... (${stems.filter((s) => s.status === 'complete').length}/12 ready)`
            : 'Split into Stems'}
        </button>
      )}
      {stemsError && (
        <div className="mt-2 text-sm text-red-600 font-instrument-serif">{stemsError}</div>
      )}
      {stems.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#1a192b]/10">
          <button
            type="button"
            onClick={() => setStemsExpanded((e) => !e)}
            className="w-full text-left text-sm font-bold font-instrument-serif flex items-center justify-between"
          >
            Stems {stemsExpanded ? '▲' : '▼'}
          </button>
          {stemsExpanded && (
            <ul className="comments-list mt-2 space-y-2 max-h-[200px] overflow-y-auto overflow-x-hidden overscroll-contain">
              {stems.map((s) => (
                <li key={s.id} className="text-[13px] font-instrument-serif">
                  <span className="font-bold text-[#1a192b]">
                    {s.title?.split(' - ').pop() ?? s.id.slice(0, 8)}
                  </span>
                  <div className="mt-1 min-h-[32px]">
                    {s.audio_url ? (
                      <audio
                        src={s.audio_url}
                        controls
                        className="w-full h-8 block"
                        aria-label={`Play ${s.title}`}
                      />
                    ) : (
                      <span className="text-gray-500 text-[12px]">Processing...</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {d.clipId && (
        <div className="mt-3 pt-3 border-t border-[#1a192b]/10">
          {commentsLoading ? (
            <div className="text-sm text-gray-500 font-instrument-serif py-2">Loading...</div>
          ) : comments.length > 0 ? (
            <ul className="comments-list space-y-2 max-h-[200px] overflow-y-auto overflow-x-hidden mb-3 overscroll-contain">
              {comments.map((c) => (
                <li key={c.id} className="text-[15px] font-instrument-serif">
                  <span className="font-bold text-[#1a192b]">{c.author_name ?? 'Anonymous'}</span>
                  <span className="text-gray-500 ml-1 text-[13px]">{formatDate(c.created_at)}</span>
                  <p className="mt-0.5 text-gray-700 break-words whitespace-pre-wrap">{c.content}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {postError && (
            <div className="text-sm text-red-600 font-instrument-serif mb-2">{postError}</div>
          )}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {FRIEND_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => handleAuthorChange(name)}
                className={`py-1 px-2.5 text-[14px] font-instrument-serif rounded-full border transition-colors ${
                  authorName === name
                    ? 'bg-[#1a192b] text-white border-[#1a192b]'
                    : 'bg-transparent text-[#1a192b] border-[#1a192b]/30 hover:border-[#1a192b]/50'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Write something incredible..."
              value={commentContent}
              onChange={(e) => {
                setCommentContent(e.target.value);
                setPostError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAddComment();
                }
              }}
              className="flex-1 py-2 pr-2 text-[16px] font-instrument-serif bg-transparent border-0 border-b border-[#1a192b]/20 outline-none placeholder:text-gray-400 focus:border-[#1a192b]/50 transition-colors"
            />
            <button
              type="button"
              onClick={handleAddComment}
              disabled={!commentContent.trim() || submitting}
              className="py-2 px-3 text-[16px] font-instrument-serif text-[#1a192b] hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed shrink-0"
            >
              {submitting ? '...' : 'Post'}
            </button>
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = {
  topic: ParamNode,
  tags: ParamNode,
  prompt: ParamNode,
  instrumental: ParamNode,
  aiPrompt: ParamNode,
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
    (type: 'topic' | 'tags' | 'prompt' | 'instrumental' | 'aiPrompt') => {
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

  const addSongNode = useCallback(() => {
    const id = `song-${Date.now()}`;
    const songNodes = nodes.filter((n) => n.type === 'song');
    const maxSongX = songNodes.length > 0 ? Math.max(...songNodes.map((n) => n.position.x)) : 0;
    const baseY = songNodes[0]?.position.y ?? 280;
    const newNode: Node<SongData> = {
      id,
      type: 'song',
      position: { x: maxSongX + 320, y: baseY },
      data: {},
    };
    setNodes((prev) => [...prev, newNode]);
  }, [nodes, setNodes]);

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
        <Panel position="top-left" className="flex gap-2 m-2.5">
          <button onClick={() => addParamNode('topic')} className={panelBtnClasses}>
            <span className="relative z-10">+ Topic</span>
          </button>
          <button onClick={() => addParamNode('aiPrompt')} className={panelBtnClasses}>
            <span className="relative z-10">+ Prompt</span>
          </button>
          <button onClick={() => addParamNode('tags')} className={panelBtnClasses}>
            <span className="relative z-10">+ Tags</span>
          </button>
          <button onClick={() => addParamNode('prompt')} className={panelBtnClasses}>
            <span className="relative z-10">+ Lyrics</span>
          </button>
          <button onClick={() => addParamNode('instrumental')} className={panelBtnClasses}>
            <span className="relative z-10">+ Instrumental</span>
          </button>
          <button onClick={addSongNode} className={panelBtnClasses}>
            <span className="relative z-10">+ Song</span>
          </button>
        </Panel>
      </ReactFlow>
    </FlowContext.Provider>
  );
}

export default function App() {
  return (
    <div className="w-screen h-screen">
      <FlowWithContext />
    </div>
  );
}
