export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) return Response.json({ error: 'Не настроена привязка Workers AI с именем AI.' }, { status: 500 });
    const body = await request.json();
    const userMessage = String(body?.message || '').trim();
    if (!userMessage) return Response.json({ error: 'Пустое сообщение.' }, { status: 400 });

    const system = `Ты — дружелюбный и практичный русскоязычный ИИ-помощник личного планировщика.
Твоя задача: понимать намерение пользователя, а не механически подставлять настройки.
Правила планирования:
- Не делай предположений, которых пользователь не просил. «Хочу встать без будильника» означает, что нельзя назначать фиксированный подъём; если точное время критично, задай один короткий уточняющий вопрос и верни plan:null.
- Не превращай время окончания дня в длительность работы. Например, «позаниматься до 12, потом примерно до 17» НЕ означает автоматически 9 часов учёбы. Разбери естественный смысл; если фраза неоднозначна, уточни.
- Учитывай названные обязательства, сон, перерывы, еду только если пользователь упомянул или это естественно и не навязывается. Оставляй буферы и отдых.
- Если пользователь просто обсуждает варианты или ещё не выбрал план, не оформляй его как готовый план (plan:null). Если он просит составить план или явно выбирает вариант, подготовь его для подтверждения.
- Никогда не утверждай, что задачи уже добавлены. Они будут добавлены только после отдельного нажатия кнопки пользователем.
- План должен быть реалистичным: не назначай перекрывающиеся задачи; используй дату YYYY-MM-DD и время HH:MM в 24-часовом формате. Для фиксированных обязательств fixed:true, иначе false.
- Если дата или длительность неясны настолько, что план может оказаться неправильным, задай один вопрос и верни plan:null.
- Ответ короткий, естественный и по-русски. При готовом плане перечисли блоки, длительность и перерывы; не добавляй фиктивные пункты вроде «вставание» или «перерыв на завтрак», если пользователь не просил планировать их отдельными задачами.

Верни ТОЛЬКО корректный JSON без markdown и без текста до/после по схеме:
{
  "reply": "Текст ответа пользователю на русском языке",
  "plan": null ИЛИ {
    "date": "YYYY-MM-DD",
    "tasks": [
      {"title":"Название задачи","duration":90,"time":"10:00","priority":"normal","fixed":false,"notes":""}
    ]
  }
}
В JSON-ответе используй настоящие JSON-значения. duration — целое число минут; time — HH:MM или пустая строка, если точное время не задано. Не включай план, если сначала нужен уточняющий вопрос.`;

    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 1100,
      temperature: 0.25
    });

    const raw = typeof result?.response === 'string' ? result.response : (typeof result === 'string' ? result : (typeof result?.result === 'string' ? result.result : (typeof result?.output === 'string' ? result.output : '')));
    let parsed;
    try {
      parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
    }

    if (!parsed || typeof parsed.reply !== 'string') {
      // If the model returned ordinary text instead of JSON, preserve it as a reply.
      // Never infer or apply a plan unless the model returned a valid structured plan.
      const plainText = raw.trim().replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '');
      if (plainText) return Response.json({ reply: plainText.slice(0, 5000), plan: null });
      const diagnostic = result && typeof result === 'object' ? JSON.stringify(result).slice(0, 1200) : '';
      return Response.json({ reply: 'Модель не вернула текстовый ответ. Попробуй отправить сообщение ещё раз.', plan: null, diagnostic: diagnostic || undefined });
    }

    let plan = null;
    if (parsed.plan && typeof parsed.plan.date === 'string' && Array.isArray(parsed.plan.tasks)) {
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.plan.date);
      const tasks = parsed.plan.tasks.filter(t => t && typeof t.title === 'string' && t.title.trim()).slice(0, 20).map(t => ({
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
