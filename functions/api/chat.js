export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) return Response.json({ error: 'Не настроена привязка Workers AI с именем AI.' }, { status: 500 });
    const body = await request.json();
    const userMessage = String(body?.message || '').trim();
    if (!userMessage) return Response.json({ error: 'Пустое сообщение.' }, { status: 400 });

    const system = `Ты — дружелюбный, внимательный русскоязычный помощник личного планировщика. Веди непрерывный диалог, обязательно учитывай историю. Короткие реплики «до 12», «нет, после 12», «я имел в виду» относятся к последнему обсуждаемому вопросу или плану. Исправляй понимание, не начинай разговор заново и не задавай повторно вопросы, на которые уже ответили.
Максимум один уточняющий вопрос за ответ; спрашивай только если без этого нельзя сделать разумный план.

СМЫСЛ:
- «Хочу встать без будильника» означает свободное утро без фиксированного времени пробуждения. Не создавай задачи «Подъём», «Вставание», «Проснуться» и не проси время подъёма.
- Различай «до 12 хочу проснуться» и «до 12 хочу учиться». Учитывай полное предложение и последующие исправления.
- «Учиться после 12 примерно до 17» означает учебное окно 12:00–17:00, а не непрерывную задачу длительностью 300 минут.
- «С девушкой до конца дня» — обязательство после указанного времени. Не спрашивай конец встречи, если можно оставить его гибким до конца доступного окна. Не утверждай, что пользователь явно выбрал 23:30, если это только настройка.
- Не придумывай задачи, еду, подъём и прочие рутины, которых пользователь не просил.
- Если запрос достаточно понятен, предложи план. Если существенная неоднозначность мешает плану, задай один точный вопрос и верни plan:null.
- Учёбу и умственную работу длительностью больше 120 минут разбивай на блоки по 45–90 минут с перерывами 5–15 минут. Не создавай один непрерывный блок на 3–5 часов.
- Учитывай существующие задачи из контекста, не дублируй их и не создавай пересечений. Дата YYYY-MM-DD, время HH:MM. duration — целое число минут от 5 до 1440. Никогда не создавай duration 0. Для фиксированных обязательств fixed:true, для гибких false.
- Никогда не говори, что задачи уже добавлены. Приложение применит план только после нажатия пользователем кнопки подтверждения.

Верни ТОЛЬКО корректный JSON:
{"reply":"текст ответа на русском","plan":null}
либо
{"reply":"текст ответа на русском","plan":{"date":"YYYY-MM-DD","tasks":[{"title":"Название задачи","duration":90,"time":"10:00","priority":"normal","fixed":false,"notes":""}]}}
Не включай задачу «Подъём» или «Вставание», если пользователь явно не попросил напоминание о пробуждении.`;

    const history = Array.isArray(body?.history)
      ? body.history.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-10).map(m => ({ role: m.role, content: m.content.slice(0, 1800) }))
      : [];
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userMessage }];

    function extractText(value, depth = 0) {
      if (depth > 7 || value == null) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const item of value) { const found = extractText(item, depth + 1); if (found) return found; }
        return '';
      }
      if (typeof value === 'object') {
        for (const key of ['response', 'output_text', 'text', 'content', 'generated_text', 'result', 'output']) {
          if (key in value) { const found = extractText(value[key], depth + 1); if (found) return found; }
        }
        if (value.choices?.[0]?.message?.content) return extractText(value.choices[0].message.content, depth + 1);
      }
      return '';
    }

    let result, raw = '';
    for (let attempt = 0; attempt < 2 && !raw.trim(); attempt++) {
      result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', { messages, max_tokens: 1600, temperature: 0.15 });
      raw = extractText(result).trim();
    }
    if (!raw) {
      const diagnostic = result && typeof result === 'object' ? JSON.stringify(result).slice(0, 800) : String(result ?? 'empty result');
      return Response.json({ error: 'Workers AI вернул пустой ответ.', diagnostic, plan: null }, { status: 502 });
    }

    const cleaned = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch {
      const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) { try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch {} }
    }
    if (!parsed || typeof parsed.reply !== 'string') return Response.json({ reply: cleaned.slice(0, 5000), plan: null });

    let plan = null;
    if (parsed.plan && typeof parsed.plan.date === 'string' && Array.isArray(parsed.plan.tasks)) {
      const date = parsed.plan.date;
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z'));
      const tasks = parsed.plan.tasks.filter(t => t && typeof t.title === 'string' && t.title.trim())
        .slice(0, 20)
        .filter(t => !/^(подъ[её]м|вставание|проснуться|пробуждение)$/i.test(t.title.trim()))
        .map(t => {
          const n = Number(t.duration);
          return {
            title: t.title.trim().slice(0, 140),
            duration: Number.isFinite(n) && n >= 5 ? Math.max(5, Math.min(1440, Math.round(n / 5) * 5)) : 0,
            time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '') ? t.time : '',
            priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
            fixed: Boolean(t.fixed),
            notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : ''
          };
        }).filter(t => t.duration >= 5);

      const timed = tasks.filter(t => t.time).sort((a, b) => a.time.localeCompare(b.time));
      const overlap = timed.some((t, i) => {
        if (i === timed.length - 1) return false;
        const next = timed[i + 1];
        const [h, m] = t.time.split(':').map(Number);
        const [nh, nm] = next.time.split(':').map(Number);
        return h * 60 + m + t.duration > nh * 60 + nm;
      });
      if (validDate && tasks.length && !overlap) plan = { date, tasks };
      else if (overlap) parsed.reply += '\nВ черновике обнаружилось пересечение времени, поэтому план нужно уточнить.';
    }
    return Response.json({ reply: parsed.reply.slice(0, 5000), plan });
  } catch (error) {
    return Response.json({ error: error?.message || 'Внутренняя ошибка ИИ.' }, { status: 500 });
  }
}
