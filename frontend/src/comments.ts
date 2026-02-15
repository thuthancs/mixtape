import { supabase } from './supabase';

export type Comment = {
  id: string;
  clip_id: string;
  content: string;
  author_name: string | null;
  created_at: string;
};

export async function fetchComments(clipId: string): Promise<Comment[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('comments')
    .select('id, clip_id, content, author_name, created_at')
    .eq('clip_id', clipId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Failed to fetch comments:', error);
    return [];
  }
  return (data ?? []) as Comment[];
}

export type AddCommentResult =
  | { success: true; data: Comment }
  | { success: false; error: string };

export async function addComment(
  clipId: string,
  content: string,
  authorName?: string
): Promise<AddCommentResult> {
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Add credentials to .env' };
  }
  const { data, error } = await supabase
    .from('comments')
    .insert({
      clip_id: clipId,
      content: content.trim(),
      author_name: authorName?.trim() || 'Anonymous',
    })
    .select('id, clip_id, content, author_name, created_at')
    .single();
  if (error) {
    console.error('Failed to add comment:', error);
    return { success: false, error: error.message };
  }
  return { success: true, data: data as Comment };
}
