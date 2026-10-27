function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env?.AI) return jsonResponse({ error: 'Не настроена привязка Workers AI с именем AI.' }, 500);

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Тело запроса должно быть корректным JSON.' }, 400); }

    const MAX_MESSAGE = 8000;
    const MAX_HISTORY_ITEMS = 12;
    const MAX_HISTORY_CONTENT = 1800;
    const repairRequest = body?.repair && typeof body.repair === 'object' ? body.repair : null;
    const userMessage = String(body?.message || '').trim().slice(0, MAX_MESSAGE);
    if (!userMessage) return jsonResponse({ error: 'Пустое сообщение.' }, 400);

    const system = `Ты — дружелюбный, внимательный русскоязычный помощник личного планировщика. Веди непрерывный диалог и учитывай историю. Короткие реплики «до 12», «нет, после 12», «я имел в виду» относятся к последнему обсуждаемому вопросу или плану. Исправляй понимание, не начинай разговор заново и не задавай повторно вопросы, на которые уже ответили.
Максимум один уточняющий вопрос за ответ; спрашивай только если без этого нельзя сделать разумный план.
КРИТИЧЕСКИ ВАЖНО ДЛЯ ДИАЛОГА:
- Всегда сначала прочитай историю. Не повторяй вопрос, на который пользователь уже ответил.
- Если ранее ты задал вопрос и пользователь отвечает коротко («да», «нет», «3 часа», «240 минут», «в 17:30»), трактуй ответ в контексте предыдущих реплик.
- Если пользователь отвечает «да» на твоё предложение/уточнение о реализуемости плана, это подтверждение: немедленно сформируй структурированный plan, не задавай тот же вопрос повторно.
- Если пользователь уже назвал начало и длительность учёбы, данных достаточно для плана. Не проси ещё раз указать длительность.
- Числа длительности интерпретируй буквально: «3 часа» = 180 минут, «240 минут» = 240 минут. Если пользователь позже явно исправил значение, используй самое позднее значение.
- Если ответ «да» подтверждает пример на 240 минут, планируй 240 минут учёбы; не превращай это значение в другое.
- Если можешь составить разумный черновик на основании контекста, верни plan, а не plan:null. Не продолжай бесконечное уточнение.

СМЫСЛ:
- «Хочу встать без будильника» означает свободное утро без фиксированного времени пробуждения. Не создавай задачи «Подъём», «Вставание», «Проснуться» и не проси время подъёма.
- Различай «до 12 хочу проснуться» и «до 12 хочу учиться». Учитывай полное предложение и последующие исправления.
- «Учиться после 12 примерно до 17» означает учебное окно 12:00–17:00, а не непрерывную задачу длительностью 300 минут.
- «С девушкой до конца дня» — обязательство после указанного времени. Не спрашивай конец встречи, если можно оставить его гибким до конца доступного окна. Не утверждай, что пользователь явно выбрал 23:30, если это только настройка.
- Не придумывай задачи, еду, подъём и прочие рутины, которых пользователь не просил.
- Если запрос достаточно понятен, предложи план. Если существенная неоднозначность мешает плану, задай один точный вопрос и верни plan:null.
- Учёбу и умственную работу длительностью больше 120 минут разбивай на блоки по 45–90 минут с перерывами 5–15 минут. Перерывы должны быть отдельными задачами, не перекрываться с блоками и не выходить за занятые интервалы. Не создавай один непрерывный блок на 3–5 часов.
- Сначала размещай фиксированные события (fixed:true), затем распределяй гибкие задачи только по свободным промежуткам; никогда не планируй гибкие задачи во время фиксированного события. Если пользователь сказал, что занят примерно до 17:00, не ставь в это окно учёбу. Учитывай существующие задачи из контекста, не дублируй их и не создавай пересечений.
- Каждая задача должна иметь дату YYYY-MM-DD, время HH:MM или пустую строку, длительность — целое число минут от 5 до 1440. Никогда не создавай duration 0. Для фиксированных обязательств fixed:true, для гибких false.
- Не включай «Подъём», «Вставание», «Проснуться» или «Пробуждение», если пользователь явно не попросил напоминание о пробуждении.
- Никогда не говори, что задачи уже добавлены. Приложение применит план только после нажатия пользователем кнопки подтверждения.

Верни ТОЛЬКО корректный JSON без Markdown:
{"reply":"текст ответа на русском","plan":null}
либо
{"reply":"текст ответа на русском","plan":{"date":"YYYY-MM-DD","tasks":[{"title":"Название задачи","duration":90,"time":"10:00","priority":"normal","fixed":false,"notes":""}]}}
Все строки JSON должны быть корректно экранированы.`;

    const history = Array.isArray(body?.history)
      ? body.history
          .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-MAX_HISTORY_ITEMS)
          .map(m => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CONTENT) }))
      : [];
    // Keep the request bounded even when history contains many long messages.
    const repairInstruction = repairRequest ? `\n\nРЕЖИМ ИСПРАВЛЕНИЯ ЧЕРНОВИКА: не составляй новый план с нуля. Исправь переданный черновик минимально. Сохрани все фиксированные события с теми же названиями, датами, временем и длительностью; сохрани суммарную длительность учебных задач; не добавляй задачи подъёма/сна. Устрани все пересечения. Верни только JSON-контракт.\nКонфликты, найденные сервером: ${JSON.stringify(repairRequest.conflicts || []).slice(0, 3000)}\nЧерновик для исправления: ${JSON.stringify(repairRequest.draft || {}).slice(0, 7000)}` : '';
    const messages = [{ role: 'system', content: system + repairInstruction }, ...history, { role: 'user', content: userMessage }];

    function extractText(value, depth = 0, seen = new WeakSet()) {
      if (depth > 7 || value == null) return '';
      if (typeof value === 'string') return value;
      if (typeof value !== 'object') return '';
      if (seen.has(value)) return '';
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 30)) {
          const found = extractText(item, depth + 1, seen);
          if (found) return found;
        }
        return '';
      }
      for (const key of ['response', 'output_text', 'text', 'content', 'generated_text', 'result', 'output']) {
        if (key in value) {
          const found = extractText(value[key], depth + 1, seen);
          if (found) return found;
        }
      }
      const choiceContent = value.choices?.[0]?.message?.content;
      if (choiceContent != null) return extractText(choiceContent, depth + 1, seen);
      return '';
    }

    let result, raw = '';
    for (let attempt = 0; attempt < 2 && !raw.trim(); attempt++) {
      result = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
        messages,
        max_tokens: 1600,
        temperature: 0.1
      });
      raw = extractText(result).trim();
    }
    if (!raw) {
      const diagnostic = result && typeof result === 'object' ? JSON.stringify(result).slice(0, 800) : String(result ?? 'empty result');
      return jsonResponse({ error: 'Workers AI вернул пустой ответ.', diagnostic, plan: null }, 502);
    }

    const cleaned = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
    // A long verbatim copy of the planner context is a failed generation, not a useful answer.
    const echoProbe = userMessage.length >= 300 ? userMessage.slice(0, 240) : '';
    if (echoProbe && cleaned.includes(echoProbe)) {
      return jsonResponse({
        reply: 'ИИ повторил контекст вместо ответа. Попробуй отправить запрос ещё раз короче; задачи не изменены.',
        plan: null
      }, 502);
    }
    function parseEnvelope(text) {
      const candidates = [text];
      const start = text.indexOf('{'), end = text.lastIndexOf('}');
      if (start >= 0 && end > start && !(start === 0 && end === text.length - 1)) candidates.push(text.slice(start, end + 1));
      for (const candidate of candidates) {
        try {
          const value = JSON.parse(candidate);
          if (value && typeof value === 'object' && typeof value.reply === 'string') return value;
        } catch {}
      }
      return null;
    }

    let parsed = parseEnvelope(cleaned);
    // A bare affirmative after the assistant proposed a plan means confirmation, not a new request for clarification.
    const currentRequest = (userMessage.match(/(?:^|\n)Запрос пользователя:\s*([^\n]+)/i)?.[1] || userMessage).trim();
    const currentIsAffirmative = /^(?:да|да,?\s*(?:давай|составляй|подходит|реалистично|верно)?|думаю,?\s*да|ок|хорошо|согласен|согласна)[.!?\s]*$/i.test(currentRequest);
    if (parsed && !parsed.plan && currentIsAffirmative) {
      try {
        const retry = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
          messages: [
            { role: 'system', content: system + '\n\nОСОБОЕ УКАЗАНИЕ: последняя реплика пользователя — подтверждение твоего предыдущего предложения. Не задавай вопрос. Составь структурированный план на основе всей истории и уже указанных ограничений. Верни JSON с plan.tasks, если только в истории действительно нет никаких задач или временных ограничений.' },
            ...history,
            { role: 'user', content: userMessage }
          ],
          max_tokens: 1600,
          temperature: 0
        });
        const retryParsed = parseEnvelope(extractText(retry).trim().replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim());
        if (retryParsed && retryParsed.plan) parsed = retryParsed;
      } catch (error) {
        console.error('[chat] affirmative-plan retry failed:', error?.message || error);
      }
    }
    if (!parsed) {
      // One repair attempt: ask the model to return a valid envelope, preserving the original request/history.
      try {
        const repair = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
          messages: [
            { role: 'system', content: 'Верни корректный JSON строго вида {\"reply\":\"...\",\"plan\":null} или {\"reply\":\"...\",\"plan\":{\"date\":\"YYYY-MM-DD\",\"tasks\":[...]}}. Если исходный ответ содержит JSON, исправь его синтаксис и сохрани смысл. Если исходный ответ не содержит пригодного плана, составь план по запросу пользователя и истории. Не добавляй Markdown и никаких пояснений вне JSON.' },
            { role: 'user', content: ('Исходный запрос пользователя и контекст:\n' + userMessage + '\n\nПредыдущий ответ модели для восстановления, если полезен:\n' + cleaned).slice(0, 9000) }
          ],
          max_tokens: 1600,
          temperature: 0
        });
        parsed = parseEnvelope(extractText(repair).trim().replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim());
      } catch {}
    }
    if (!parsed) {
      return jsonResponse({
        reply: 'Не удалось надёжно разобрать ответ ИИ. Попробуй повторить запрос короче или переформулировать его.',
        plan: null
      });
    }

    // Detect a conversational loop: the model repeats its previous assistant reply verbatim.
    // Compare only parsed reply text, and only when no usable plan accompanies it.
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    const normalizeForLoop = value => String(value || '').trim().replace(/\s+/g, ' ');
    if (lastAssistant && parsed.reply && !parsed.plan &&
        normalizeForLoop(lastAssistant.content) === normalizeForLoop(parsed.reply)) {
      return jsonResponse({
        reply: 'Похоже, я зациклился на предыдущем ответе. Давай переформулируем запрос — что именно нужно сделать?',
        plan: null
      });
    }

    let reply = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 5000) : '';
    if (!reply.trim()) reply = 'ИИ вернул пустой ответ.';

    const isFixed = v => v === true || v === 'true' || v === 1;
    const validTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    const toMin = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
    const normalizePlan = candidate => {
      if (!candidate || typeof candidate.date !== 'string' || !Array.isArray(candidate.tasks)) return { plan: null, reason: 'Структура черновика плана оказалась некорректной.', conflicts: [], draft: candidate || null };
      const date = candidate.date;
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
      const rawTasks = candidate.tasks.slice(0, 30);
      const hasInvalidFixed = rawTasks.some(t => t && isFixed(t.fixed) && !validTime(t.time));
      let tasks = rawTasks.filter(t => t && typeof t.title === 'string' && t.title.trim())
        .filter(t => !/^(подъ[её]м|вставание|проснуться|пробуждение)$/i.test(t.title.trim()))
        .map(t => { const n = Number(t.duration); return { title: t.title.trim().slice(0,140), duration: Number.isFinite(n) && n >= 5 ? Math.min(1440, Math.round(n/5)*5) : 0, time: validTime(t.time) ? t.time : '', priority: ['high','normal','low'].includes(t.priority) ? t.priority : 'normal', fixed: isFixed(t.fixed) && validTime(t.time), notes: typeof t.notes === 'string' ? t.notes.slice(0,500) : '' }; })
        .filter(t => t.duration >= 5);
      const hasLongTimedStudy = tasks.some(t => t.time && t.duration > 120 && /(уч[её]б|учиться|обучен|подготовк|программирован|лабораторн|домашн.{0,10}задан|чтени|работ.{0,10}над)/i.test(t.title));
      if (hasLongTimedStudy) tasks = tasks.filter(t => !/^перерыв(?: между учебными блоками)?$/i.test(t.title.trim()));
      const timed = tasks.filter(t => t.time).map(t => ({ ...t, start: toMin(t.time) })).sort((a,b) => a.start-b.start);
      const conflicts = [];
      for (let i=0;i<timed.length;i++) for (let j=i+1;j<timed.length;j++) {
        if (timed[j].start >= timed[i].start + timed[i].duration) break;
        conflicts.push({ a: { title: timed[i].title, time: timed[i].time, duration: timed[i].duration, fixed: timed[i].fixed }, b: { title: timed[j].title, time: timed[j].time, duration: timed[j].duration, fixed: timed[j].fixed } });
      }
      let reason = '';
      if (!validDate) reason = 'Указана некорректная дата.';
      else if (hasInvalidFixed) reason = 'Фиксированное событие не содержит корректного времени начала.';
      else if (!tasks.length) reason = 'Все задачи в черновике имели некорректную или слишком короткую длительность.';
      else if (conflicts.length) reason = 'В черновике обнаружено пересечение времени.';
      else if (timed.some(t => t.start + t.duration > 1440)) reason = 'Одна из задач выходит за пределы суток.';
      return { plan: reason ? null : { date, tasks }, reason, conflicts, draft: { date, tasks } };
    };
    const planWasSupplied = parsed.plan != null;
    let checked = normalizePlan(parsed.plan);
    let plan = checked.plan;

    // A user-triggered repair must preserve the original fixed events and total study time too.
    if (repairRequest) {
      const original = repairRequest.draft;
      const fixedKey = t => `${t.title.toLocaleLowerCase('ru-RU')}|${t.time}|${t.duration}`;
      const fixedBefore = (original?.tasks || []).filter(t => t && isFixed(t.fixed)).map(fixedKey).sort();
      const fixedAfter = (checked.draft?.tasks || []).filter(t => t && isFixed(t.fixed)).map(fixedKey).sort();
      const studyRe = /(уч[её]б|учиться|обучен|подготовк|программирован|лабораторн|домашн.{0,10}задан|чтени|работ.{0,10}над)/i;
      const studyTotal = p => (p?.tasks || []).filter(t => studyRe.test(t.title)).reduce((sum,t) => sum + Number(t.duration || 0), 0);
      const integrityOk = !!checked.plan && checked.draft?.date === original?.date && JSON.stringify(fixedBefore) === JSON.stringify(fixedAfter) && studyTotal(original) === studyTotal(checked.draft);
      if (!integrityOk) {
        checked = { plan: null, reason: 'Исправление изменило фиксированные события или общую длительность учёбы либо не устранило ошибки.', conflicts: Array.isArray(repairRequest.conflicts) ? repairRequest.conflicts : [], draft: original || checked.draft };
        plan = null;
      }
    }

    // One automatic, targeted repair when the first structured plan contains overlaps.
    // A user-triggered repair request is itself the one manual retry; do not recurse again.
    if (planWasSupplied && !plan && checked.conflicts.length && !repairRequest) {
      try {
        const repairPrompt = `Исправь этот черновик минимально. Найденные пересечения: ${JSON.stringify(checked.conflicts)}. Черновик: ${JSON.stringify(checked.draft)}. Сохрани все фиксированные задачи без изменения title/time/duration/date, а также суммарную длительность учебных задач. Устрани пересечения и не создавай задачи на подъём/сон. Верни только JSON {"reply":"...","plan":{"date":"YYYY-MM-DD","tasks":[...]}}.`;
        const repairedRaw = extractText(await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', { messages: [{role:'system',content:system}, ...history, {role:'user',content:repairPrompt}], max_tokens:1600, temperature:0 }));
        const repairedParsed = parseEnvelope(repairedRaw.trim().replace(/^```(?:json|text)?\s*/i,'').replace(/\s*```$/,''));
        if (repairedParsed?.plan) {
          const candidate = normalizePlan(repairedParsed.plan);
          const fixedKey = t => `${t.title.toLocaleLowerCase('ru-RU')}|${t.time}|${t.duration}`;
          const fixedBefore = checked.draft.tasks.filter(t=>t.fixed).map(fixedKey).sort();
          const fixedAfter = candidate.draft?.tasks?.filter(t=>t.fixed).map(fixedKey).sort() || [];
          const studyRe = /(уч[её]б|учиться|обучен|подготовк|программирован|лабораторн|домашн.{0,10}задан|чтени|работ.{0,10}над)/i;
          const studyTotal = p => (p?.tasks||[]).filter(t=>studyRe.test(t.title)).reduce((s,t)=>s+t.duration,0);
          const fixedPreserved = candidate.draft?.date === checked.draft?.date && JSON.stringify(fixedBefore) === JSON.stringify(fixedAfter);
          const studyPreserved = Math.abs(studyTotal(checked.draft)-studyTotal(candidate.draft)) <= 0;
          if (candidate.plan && fixedPreserved && studyPreserved) { checked = candidate; plan = candidate.plan; reply = repairedParsed.reply || 'Исправил пересечения. Проверь черновик перед добавлением.'; }
        }
      } catch (error) { console.error('[chat] overlap repair failed:', error?.message || error); }
    }

    if (planWasSupplied && !plan) {
      const diagnostic = checked.conflicts.length ? checked.conflicts.map(c => `«${c.a.title}» ${c.a.time}–${String(Math.floor((toMin(c.a.time)+c.a.duration)/60)).padStart(2,'0')}:${String((toMin(c.a.time)+c.a.duration)%60).padStart(2,'0')} пересекается с «${c.b.title}» ${c.b.time}–${String(Math.floor((toMin(c.b.time)+c.b.duration)/60)).padStart(2,'0')}:${String((toMin(c.b.time)+c.b.duration)%60).padStart(2,'0')}`).join('; ') : checked.reason;
      reply += '\n\nЧерновик не добавлен: ' + (diagnostic || 'план не прошёл проверку.') + (checked.conflicts.length ? ' Можно нажать «Попробовать исправить» для одной дополнительной попытки.' : ' Задачи не изменены.');
      return jsonResponse({ reply, plan: null, conflicts: checked.conflicts, draft: checked.draft, canRepair: checked.conflicts.length > 0 && !repairRequest });
    }
    if (!plan && /(?:вот (?:твой |ваш )?план|план готов|составил(?:а)? план|расписание готово|я распределил(?:а)? задачи)/i.test(reply)) reply += '\n\nВажно: структурированный черновик не был получен, поэтому задачи не добавлены.';
    return jsonResponse({ reply, plan, conflicts: [], draft: null, canRepair: false });
  } catch (error) {
    console.error('[chat] Workers AI request failed:', error?.stack || error?.message || error);
    return jsonResponse({ error: 'Не удалось обработать запрос ИИ. Попробуй ещё раз.' }, 500);
  }
}
