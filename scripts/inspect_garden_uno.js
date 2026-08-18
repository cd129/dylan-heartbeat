const { GardenMcpClient } = require('../garden_mcp_client');

function unwrapToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter(item => item && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text);
    for (const text of texts) {
      try { return JSON.parse(text); } catch {}
    }
    return texts.join('\n');
  }
  return result;
}

async function main() {
  const client = new GardenMcpClient();
  try {
    const gamesRaw = await client.callTool('list_games', {});
    const games = unwrapToolResult(gamesRaw);
    console.log(`UNO_LIST_GAMES ${JSON.stringify(games)}`);

    const serialized = JSON.stringify(games);
    const candidates = [];
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(walk);
      const name = String(value.name || value.title || value.game_name || '');
      const id = value.game_id || value.id;
      if (id && /uno/i.test(name + ' ' + String(id))) candidates.push(String(id));
      Object.values(value).forEach(walk);
    };
    walk(games);

    const unoGameId = candidates[0];
    if (!unoGameId) {
      console.log(`UNO_GAME_ID_NOT_FOUND ${serialized.slice(0, 4000)}`);
      return;
    }

    const schemaRaw = await client.callTool('get_tool_schema', {
      tool_name: 'submit_action',
      game_id: unoGameId
    });
    console.log(`UNO_ACTION_SCHEMA ${JSON.stringify({ game_id: unoGameId, result: unwrapToolResult(schemaRaw) })}`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('UNO_INSPECTION_FAILED', error?.message || String(error));
  process.exit(1);
});
