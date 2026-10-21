
export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) {
      return Response.json(
        { error: "Workers AI не подключён" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const message = String(body.message || "").trim();

    if (!message) {
      return Response.json(
        { error: "Напиши сообщение" },
        { status: 400 }
      );
    }

    if (message.length > 4000) {
      return Response.json(
        { error: "Сообщение слишком длинное" },
        { status: 400 }
      );
    }

    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          {
            role: "system",
            content:
              "Ты — дружелюбный ИИ-помощник приложения-планировщика. " +
              "Помогай планировать день, распределять задачи по времени " +
              "и оценивать длительность дел. Отвечай по-русски, кратко " +
              "и практично. Не утверждай, что добавил или изменил задачи: " +
              "ты только предлагаешь план, пользователь подтверждает изменения."
          },
          {
            role: "user",
            content: message
          }
        ],
        max_tokens: 700
      }
    );

    return Response.json({
      reply: result.response || "Не удалось получить ответ. Попробуй ещё раз."
    });
  } catch (error) {
    return Response.json(
      { error: "Ошибка ИИ. Проверь подключение Workers AI и попробуй снова." },
      { status: 500 }
    );
  }
}
