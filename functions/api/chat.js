export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) return Response.json({ error: 'Не настроена привязка Workers AI с именем AI.' }, { status: 500 });
    const body = await request.json();
    const userMessage = String(body?.message || '').trim();
    if (!userMessage) return Response.json({ error: 'Пустое сообщение.' }, { status: 400 });

    const system = `Ты — дружелюбный, внимательный русскоязычный помощник личного планировщика. Веди себя как участник непрерывного диалога: обязательно учитывай предыдущие сообщения пользователя и свои ответы, сохраняй уже выясненные факты и исправляй своё понимание, когда пользователь говорит «нет», «я имел в виду», «после 12», «не так» и подобное. Не задавай повторно вопросы, на которые уже ответили.

ПРАВИЛА ДИАЛОГА:
- Интерпретируй короткие реплики относительно последнего обсуждаемого плана. Например, после вопроса о времени фраза «до 12» отвечает на этот вопрос; «нет, после 12» исправляет его на после 12. Не начинай разговор заново.
- Если пользователь исправляет предыдущую интерпретацию, извинись кратко, переформулируй обновлённое понимание и продолжай. Не задавай вопрос о факте, который уже ясен из контекста.
- Задавай максимум один конкретный уточняющий вопрос за ответ, только если без него действительно нельзя сделать разумный план. Не превращай простой запрос в анкету.
- «Хочу встать без будильника» значит свободное время пробуждения: не назначай подъём и не проси точное время, если для плана это не обязательно.
- Фразы вроде «до 12 поучиться, примерно до 17 дела» трактуй с учётом всего предложения. Если смысл можно разумно понять из контекста — предложи план; если нет, задай один точный вопрос. Не придумывай девять часов учёбы.
- Когда пользователь говорит «до 12 я хочу проснуться», понимай это как пробуждение до 12, а не учёбу до 12. Если затем уточняет «учёба после 12», используй именно это.

ПРАВИЛА ПЛАНА:
- Учитывай контекст планировщика в последнем сообщении: текущую дату, завтра, настройки и существующие задачи.
- Не придумывай задачи, которые пользователь не просил, и не добавляй рутинные пункты «вставание», «завтрак» и т.п., если пользователь не хочет их планировать.
- Если пользователь описал намерение на день достаточно ясно, сформируй предварительный план с задачами и реалистичными длительностями. Если конкретная длительность гибкой задачи неизвестна, используй разумный блок и обозначь его как предложение, а не как факт.
- Не ставь фиксированное время пробуждения, если человек хочет проснуться без будильника. Не назначай задачи поверх фиксированных обязательств и не создавай пересечения.
- Не дублируй уже существующие задачи без необходимости. Дата должна быть YYYY-MM-DD, время HH:MM в 24-часовом формате. Для обязательств fixed:true, для гибких задач false. duration — целое число минут.
- НИКОГДА не говори, что задачи уже добавлены. План только предлагается; приложение добавит его лишь после отдельного нажатия кнопки.
- При простом обсуждении или если требуется существенное уточнение верни plan:null. При готовом варианте, который можно подтвердить, верни план.
- Ответ короткий, естественный, на русском, учитывай весь разговор.

Верни только корректный JSON без markdown: {"reply":"текст ответа","plan":null} либо {"reply":"текст ответа","plan":{"date":"YYYY-MM-DD","tasks":[{"title":"Название задачи","duration":90,"time":"10:00","priority":"normal","fixed":false,"notes":""}]}}. В JSON должны быть настоящие строки/числа/значения null.`;

    const history = Array.isArray(body?.history) ? body.history
      .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2500) })) : [];
    // Keep the current planner context as the latest user message, after the prior turns.
    const messages = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: userMessage }
    ];

    function extractText(value, depth = 0) {
      if (depth > 6 || value == null) return '';
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
      result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', { messages, max_tokens: 1400, temperature: 0.25 });
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
    if (!parsed || typeof parsed.reply !== 'string') {
      // Preserve readable model text; never infer a plan from unstructured output.
      return Response.json({ reply: cleaned.slice(0, 5000), plan: null });
    }

    let plan = null;
    if (parsed.plan && typeof parsed.plan.date === 'string' && Array.isArray(parsed.plan.tasks)) {
      const date = parsed.plan.date;
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z'));
      const tasks = parsed.plan.tasks.filter(t => t && typeof t.title === 'string' && t.title.trim()).slice(0, 20).map(t => ({
        title: t.title.trim().slice(0, 140),
        duration: Math.max(5, Math.min(1440, Math.round((Number(t.duration) || 60) / 5) * 5)),
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '') ? t.time : '',
        priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
        fixed: Boolean(t.fixed),
        notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : ''
      }));
      if (validDate && tasks.length) plan = { date, tasks };
    }
    return Response.json({ reply: parsed.reply.slice(0, 5000), plan });
  } catch (error) {
    return Response.json({ error: error?.message || 'Внутренняя ошибка ИИ.' }, { status: 500 });
  }
}
