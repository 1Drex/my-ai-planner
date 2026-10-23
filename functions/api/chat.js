export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) return Response.json({ error: 'Не настроена привязка Workers AI с именем AI.' }, { status: 500 });
    const body = await request.json();
    const userMessage = String(body?.message || '').trim();
    if (!userMessage) return Response.json({ error: 'Пустое сообщение.' }, { status: 400 });

    const system = `Ты — дружелюбный и практичный русскоязычный ИИ-помощник личного планировщика.
Понимай смысл запроса, не выдумывай расписание и не назначай фиксированный подъём, если человек хочет встать без будильника. Не превращай «заняться до 12, потом примерно до 17» в девять часов учёбы: если смысл важной части неясен, задай один короткий уточняющий вопрос и верни plan:null.
Не добавляй фиктивные пункты вроде подъёма или завтрака, если их не просили планировать. Не утверждай, что задачи уже добавлены. План только предлагается и добавляется лишь после нажатия пользователем кнопки.
Если план понятен, предложи реалистичные задачи без пересечений. Используй дату YYYY-MM-DD, время HH:MM (24 часа), duration — целое число минут. Для обязательств fixed:true, для гибких задач false.
Верни только JSON без markdown в форме: {"reply":"короткий ответ на русском","plan":null} либо {"reply":"ответ","plan":{"date":"YYYY-MM-DD","tasks":[{"title":"Название","duration":90,"time":"10:00","priority":"normal","fixed":false,"notes":""}]}}. Если нужна уточняющая информация, plan должен быть null.`;

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ];

    // Workers AI usually returns { response: "..." }, but unwrap other response shapes too.
    function extractText(value, depth = 0) {
      if (depth > 5 || value == null) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = extractText(item, depth + 1);
          if (found) return found;
        }
        return '';
      }
      if (typeof value === 'object') {
        for (const key of ['response', 'output_text', 'text', 'content', 'generated_text', 'result', 'output']) {
          if (key in value) {
            const found = extractText(value[key], depth + 1);
            if (found) return found;
          }
        }
        if (value.choices?.[0]?.message?.content) return extractText(value.choices[0].message.content, depth + 1);
      }
      return '';
    }

    let result;
    let raw = '';
    // Retry once if the model returns an empty response.
    for (let attempt = 0; attempt < 2 && !raw.trim(); attempt++) {
      result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
        messages,
        max_tokens: 1200,
        temperature: 0.2
      });
      raw = extractText(result).trim();
    }

    if (!raw) {
      const diagnostic = result && typeof result === 'object' ? JSON.stringify(result).slice(0, 800) : String(result ?? 'empty result');
      return Response.json({
        reply: 'Cloudflare Workers AI вернул пустой ответ после двух попыток. Проверь журнал Functions в Cloudflare Pages: там будет видно, почему модель не вернула текст.',
        plan: null,
        diagnostic
      }, { status: 502 });
    }

    const cleaned = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch {}
      }
    }

    // If JSON formatting fails, still show the model's actual answer as ordinary text.
    if (!parsed || typeof parsed.reply !== 'string') {
      return Response.json({ reply: cleaned.slice(0, 5000), plan: null });
    }

    let plan = null;
    if (parsed.plan && typeof parsed.plan.date === 'string' && Array.isArray(parsed.plan.tasks)) {
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.plan.date);
      const tasks = parsed.plan.tasks
        .filter(t => t && typeof t.title === 'string' && t.title.trim())
        .slice(0, 20)
        .map(t => ({
          title: t.title.trim().slice(0, 140),
          duration: Math.max(5, Math.min(1440, Math.round((Number(t.duration) || 60) / 5) * 5)),
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '') ? t.time : '',
          priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
          fixed: Boolean(t.fixed),
          notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : ''
        }));
      if (validDate && tasks.length) plan = { date: parsed.plan.date, tasks };
    }
    return Response.json({ reply: parsed.reply.slice(0, 5000), plan });
  } catch (error) {
    return Response.json({ error: error?.message || 'Внутренняя ошибка ИИ.' }, { status: 500 });
  }
}
