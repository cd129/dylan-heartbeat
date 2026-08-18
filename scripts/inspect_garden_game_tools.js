const { GardenMcpClient } = require('../garden_mcp_client');

async function main() {
  const client = new GardenMcpClient();
  try {
    const tools = await client.listAllTools();
    const picked = tools
      .filter(tool => {
        const text = `${tool?.name || ''} ${tool?.description || ''}`;
        return /game|uno/i.test(text);
      })
      .map(tool => ({
        name: String(tool?.name || ''),
        description: typeof tool?.description === 'string' ? tool.description : '',
        inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : {}
      }));

    console.log(`GAME_TOOL_METADATA ${JSON.stringify(picked)}`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('GAME_TOOL_METADATA_FAILED', error?.message || String(error));
  process.exit(1);
});
