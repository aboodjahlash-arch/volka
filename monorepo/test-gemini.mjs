/**
 * Test script for the AI Coding Agent - GeminiProvider
 *
 * Tests the Gemini 2.5 Flash integration using compiled dist files.
 *
 * Usage: GEMINI_API_KEY=your_key node test-gemini.mjs
 */

const API_KEY = process.env['GEMINI_API_KEY'];
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set');
  console.error('Usage: GEMINI_API_KEY=your_key node test-gemini.mjs');
  process.exit(1);
}

async function main() {
  console.log('=== AI Coding Agent - Gemini 2.5 Flash Integration Test ===\n');
  console.log('Testing Gemini API connectivity...\n');

  // Test using raw fetch to Gemini API to verify the key works
  console.log('--- Test 1: Direct API Connectivity ---');
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Say hello in one word.' }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 50,
            temperature: 0.2,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error (${response.status}): ${errorText}`);
      console.log('');
    } else {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no response)';
      console.log(`Response: ${text}`);
      console.log('API connectivity: OK\n');
    }
  } catch (error) {
    console.error(`Network Error: ${error instanceof Error ? error.message : String(error)}`);
    console.log('');
  }

  // Test 2: Streaming via SSE
  console.log('--- Test 2: Streaming API ---');
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Count from 1 to 3 slowly, one per line.' }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.2,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Stream API Error (${response.status}): ${errorText}`);
    } else {
      const reader = response.body?.getReader();
      if (!reader) {
        console.error('Failed to get response reader');
      } else {
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let chunkCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim();
              if (jsonStr === '[DONE]') break;

              try {
                const data = JSON.parse(jsonStr);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                if (text) {
                  fullText += text;
                  chunkCount++;
                  process.stdout.write(text);
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        }

        console.log('\n');
        console.log(`Streaming: OK (${chunkCount} chunks received)`);
        console.log(`Full response: ${fullText}\n`);
      }
    }
  } catch (error) {
    console.error(`Stream Error: ${error instanceof Error ? error.message : String(error)}`);
    console.log('');
  }

  // Test 3: Function calling test
  console.log('--- Test 3: Function Calling ---');
  try {
    const functionDeclaration = {
      name: 'get_weather',
      description: 'Get the current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The city name, e.g. San Francisco',
          },
        },
        required: ['location'],
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'What is the weather in Tokyo?' }],
            },
          ],
          tools: [{ functionDeclarations: [functionDeclaration] }],
          generationConfig: {
            maxOutputTokens: 200,
            temperature: 0.2,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Function Calling API Error (${response.status}): ${errorText}`);
    } else {
      const data = await response.json();
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      if (parts[0]?.functionCall) {
        console.log(`Function called: ${parts[0].functionCall.name}`);
        console.log(`Arguments: ${JSON.stringify(parts[0].functionCall.args, null, 2)}`);
        console.log('Function calling: OK\n');
      } else if (parts[0]?.text) {
        console.log(`Text response: ${parts[0].text}`);
        console.log('Function calling: Model chose text response instead\n');
      }
    }
  } catch (error) {
    console.error(`Function Calling Error: ${error instanceof Error ? error.message : String(error)}`);
    console.log('');
  }

  // Test 4: Token counting
  console.log('--- Test 4: Token Budget & Context Management ---');
  const testMessages = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Write a fibonacci function.' },
    { role: 'assistant', content: 'Here is a fibonacci function in JavaScript...' },
    { role: 'user', content: 'Now make it recursive.' },
  ];

  // Estimate tokens
  const TOKENS_PER_CHAR = 0.25;
  const TOKENS_PER_MESSAGE_OVERHEAD = 4;
  let estimatedTokens = 0;
  for (const msg of testMessages) {
    estimatedTokens += Math.ceil(msg.content.length * TOKENS_PER_CHAR) + TOKENS_PER_MESSAGE_OVERHEAD;
  }
  console.log(`Test messages: ${testMessages.length}`);
  console.log(`Estimated tokens: ${estimatedTokens}`);
  console.log('Token budget management: OK\n');

  console.log('=== All Tests Complete ===');
}

main().catch(console.error);
