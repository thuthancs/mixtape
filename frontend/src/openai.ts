function getApiKey(): string | null {
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  return key && typeof key === 'string' ? key : null;
}

const REFINE_SYSTEM =
  'You help users describe music for AI music generation. Given their rough idea, return a clear, detailed music description (1-2 sentences) suitable for Suno-style generation. Include mood, genre, instruments, and theme. Return ONLY the refined description, no quotes or extra text.';

export async function refineMusicPrompt(userPrompt: string): Promise<string> {
  const key = getApiKey();
  if (!key) throw new Error('VITE_OPENAI_API_KEY is not set. Add it to your .env file.');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: REFINE_SYSTEM },
        { role: 'user', content: userPrompt.trim() || 'I want some music but I\'m not sure how to describe it.' },
      ],
      max_tokens: 150,
    }),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error?: { message?: string } };
    throw new Error(err?.error?.message ?? `OpenAI API error: ${res.status}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('No response from OpenAI');
  return content;
}
