/**
 * ai-services.js
 * AI service interactions for the Task Master CLI
 */

// NOTE/TODO: Include the beta header output-128k-2025-02-19 in your API request to increase the maximum output token length to 128k tokens for Claude 3.7 Sonnet.

// import { Anthropic } from '@anthropic-ai/sdk'; // Remove Anthropic
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { CONFIG, log, sanitizePrompt } from './utils.js';
import { startLoadingIndicator, stopLoadingIndicator } from './ui.js';
import chalk from 'chalk';

// Load environment variables
dotenv.config();

// Configure OpenAI client for OpenRouter
const openAI = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    // Recommended headers for OpenRouter
    // TODO: Make these configurable?
    'HTTP-Referer': 'http://localhost:3000', // Replace with your actual site URL
    'X-Title': 'Task Master CLI', // Replace with your actual site name
  },
});

/* // Temporarily comment out Perplexity client
// Lazy-loaded Perplexity client
let perplexity = null;

/**
 * Get or initialize the Perplexity client
 * @returns {OpenAI} Perplexity client
 */
/*
function getPerplexityClient() {
  if (!perplexity) {
    if (!process.env.PERPLEXITY_API_KEY) {
      throw new Error("PERPLEXITY_API_KEY environment variable is missing. Set it to use research-backed features.");
    }
    // Assuming OpenAI SDK is compatible or a specific Perplexity SDK is used
    perplexity = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: 'https://api.perplexity.ai',
    });
  }
  return perplexity;
}
*/

/**
 * Handle AI API errors with user-friendly messages
 * @param {Error} error - The error from the AI API
 * @param {string} serviceName - Name of the service (e.g., 'OpenRouter', 'Perplexity')
 * @returns {string} User-friendly error message
 */
function handleAIError(error, serviceName = 'AI Service') {
  log('error', `Error from ${serviceName}:`, error); // Log the original error

  // Check for OpenAI/OpenRouter specific structured errors
  if (error.response && error.response.data && error.response.data.error) {
    const errData = error.response.data.error;
    log('debug', `${serviceName} API Error Details:`, errData);
    switch (errData.type) {
      case 'invalid_request_error':
        return `Invalid request to ${serviceName}: ${errData.message}. Please check parameters.`;
      case 'authentication_error':
        return `Authentication error with ${serviceName}. Please check your API key (OPENROUTER_API_KEY or PERPLEXITY_API_KEY).`;
      case 'permission_error':
        return `Permission denied for ${serviceName}. Check your API key permissions.`;
      case 'rate_limit_error':
        return `Rate limit exceeded for ${serviceName}. Please wait and try again. ${errData.message || ''}`;
      case 'api_error': // General API error
      case 'internal_server_error': // OpenRouter might use this
        return `${serviceName} is currently unavailable or experiencing issues. Please try again later. ${errData.message || ''}`;
      default:
        return `An unexpected error occurred with ${serviceName}: ${errData.message || 'Unknown API error'}`;
    }
  }

  // Check for network/timeout errors
  if (error.message?.toLowerCase().includes('timeout')) {
    return `The request to ${serviceName} timed out. Please try again.`;
  }
  if (error.code === 'ENOTFOUND' || error.message?.toLowerCase().includes('network')) {
    return `There was a network error connecting to ${serviceName}. Please check your internet connection and API endpoint (${serviceName === 'OpenRouter' ? process.env.OPENROUTER_API_BASE : 'https://api.perplexity.ai'}).`;
  }

  // Default error message
  return `Error communicating with ${serviceName}: ${error.message || 'Unknown error'}`;
}

/**
 * Call AI (via OpenRouter) to generate tasks from a PRD
 * Renamed from callClaude
 * @param {string} prdContent - PRD content
 * @param {string} prdPath - Path to the PRD file
 * @param {number} numTasks - Number of tasks to generate
 * @param {number} retryCount - Retry count
 * @returns {Object} AI's response
 */
async function generateTasksFromPRD(prdContent, prdPath, numTasks, retryCount = 0) {
  try {
    log('info', 'Calling OpenRouter AI...');

    // Build the system prompt (same as before)
    const systemPrompt = `You are an AI assistant helping to break down a Product Requirements Document (PRD) into a set of sequential development tasks.
Your goal is to create ${numTasks} well-structured, actionable development tasks based on the PRD provided.

Each task should follow this JSON structure:
{
  "id": number,
  "title": string,
  "description": string,
  "status": "pending",
  "dependencies": number[] (IDs of tasks this depends on),
  "priority": "high" | "medium" | "low",
  "details": string (implementation details),
  "testStrategy": string (validation approach)
}

Guidelines:
1. Create exactly ${numTasks} tasks, numbered from 1 to ${numTasks}
2. Each task should be atomic and focused on a single responsibility
3. Order tasks logically - consider dependencies and implementation sequence
4. Early tasks should focus on setup, core functionality first, then advanced features
5. Include clear validation/testing approach for each task
6. Set appropriate dependency IDs (a task can only depend on tasks with lower IDs)
7. Assign priority (high/medium/low) based on criticality and dependency order
8. Include detailed implementation guidance in the "details" field

Expected output format:
{
  "tasks": [
    {
      "id": 1,
      "title": "Setup Project Repository",
      "description": "...",
      ...
    },
    ...
  ],
  "metadata": {
    "projectName": "PRD Implementation",
    "totalTasks": ${numTasks},
    "sourceFile": "${prdPath}",
    "generatedAt": "YYYY-MM-DD"
  }
}

Important: Your response must be valid JSON only, with no additional explanation or comments.`;

    // Use streaming request
    return await handleStreamingRequest(
        systemPrompt,
        `Here's the Product Requirements Document (PRD) to break down into ${numTasks} tasks:\n\n${prdContent}`,
        process.env.OPENROUTER_MODEL || CONFIG.model, // Use OpenRouter model first
        CONFIG.maxTokens,
        CONFIG.temperature,
        'OpenRouter'
      );
  } catch (error) {
    const userMessage = handleAIError(error, 'OpenRouter'); // Pass service name
    log('error', userMessage);

    // Simplified retry logic for common transient errors
    if (retryCount < 2 && (
      error.message?.includes('Rate limit') ||
      error.message?.includes('overloaded') ||
      error.message?.includes('timed out') ||
      error.message?.includes('network error') ||
      error.message?.includes('unavailable')
    )) {
      const waitTime = (retryCount + 1) * 5000; // 5s, then 10s
      log('info', `Waiting ${waitTime/1000} seconds before retry ${retryCount + 1}/2...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return await generateTasksFromPRD(prdContent, prdPath, numTasks, retryCount + 1);
    } else {
      console.error(chalk.red(userMessage));
      if (CONFIG.debug) {
        log('debug', 'Full error details:', error);
      }
      // No need to re-throw if already logged and informed user
      // throw new Error(userMessage);
      return null; // Indicate failure
    }
  }
}

/**
 * Handle streaming request to AI (OpenRouter or Perplexity)
 * @param {string} systemPrompt - System prompt content
 * @param {string} userPrompt - User prompt content
 * @param {string} model - The model to use
 * @param {number} maxTokens - Maximum tokens
 * @param {number} temperature - Temperature setting
 * @param {string} serviceName - 'OpenRouter' or 'Perplexity'
 * @param {object} client - The API client (openAI or perplexity)
 * @returns {Promise<string>} Resolves with the complete response text
 */
async function handleStreamingRequest(systemPrompt, userPrompt, model, maxTokens, temperature, serviceName, client) {
  const loadingIndicator = startLoadingIndicator(`Calling ${serviceName} AI (stream)...`);
  let responseText = '';
  let streamingInterval = null;
  const api = client || (serviceName === 'Perplexity' ? getPerplexityClient() : openAI); // Use correct client

  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const stream = await api.chat.completions.create({
      model: model,
      max_tokens: maxTokens,
      temperature: temperature,
      messages: messages,
      stream: true,
    });

    // Update loading indicator
    let dotCount = 0;
    const readline = await import('readline');
    streamingInterval = setInterval(() => {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`Receiving streaming response from ${serviceName}${'.'.repeat(dotCount)}`); // Fix: Corrected template literal escape
      dotCount = (dotCount + 1) % 4;
    }, 500);

    // Process the stream
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        responseText += content;
      }
      // Handle potential finish reasons or errors within the stream if needed
      // const finishReason = chunk.choices[0]?.finish_reason;
      // if (finishReason) {
      //   log('debug', `Stream finished with reason: ${finishReason}`);
      // }
    }

    if (streamingInterval) clearInterval(streamingInterval);
    readline.cursorTo(process.stdout, 0); // Clear loading line
    readline.clearLine(process.stdout, 0);
    stopLoadingIndicator(loadingIndicator); // Stop spinner

    log('info', `Completed streaming response from ${serviceName} API!`);

    // Assuming processClaudeResponse is adapted or replaced later
    // For now, just return the raw text
    // return processClaudeResponse(responseText, numTasks, 0, prdContent, prdPath);
    return responseText; // Return raw text for now

  } catch (error) {
    if (streamingInterval) clearInterval(streamingInterval);
    stopLoadingIndicator(loadingIndicator);

    const userMessage = handleAIError(error, serviceName);
    log('error', userMessage);
    console.error(chalk.red(userMessage));

    if (CONFIG.debug) {
      log('debug', `Full error details from ${serviceName}:`, error);
    }
    throw new Error(userMessage); // Re-throw the user-friendly message
  }
}

/**
 * Process the AI response to extract JSON
 * Adapted from processClaudeResponse
 * @param {string} textContent - Text content from AI
 * @param {number} expectedTaskCount - Expected number of tasks (for validation, optional)
 * @param {number} retryCount - Current retry count (for potential retries)
 * @returns {Object|null} Parsed JSON object or null on failure
 */
function processAIResponse(textContent, expectedTaskCount = null, retryCount = 0) {
  try {
    // Attempt to parse the JSON response
    let jsonStart = textContent.indexOf('{');
    let jsonEnd = textContent.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      log('warn', 'AI response did not contain valid JSON structure.', textContent);
      throw new Error('AI response was not in the expected JSON format.');
    }

    const jsonString = textContent.substring(jsonStart, jsonEnd + 1);
    const parsedResponse = JSON.parse(jsonString);

    // Basic validation (can be expanded)
    if (!parsedResponse.tasks || !Array.isArray(parsedResponse.tasks)) {
      log('warn', 'Parsed JSON response is missing the "tasks" array.', parsedResponse);
      throw new Error('AI response JSON is missing the required "tasks" array.');
    }

    if (expectedTaskCount !== null && parsedResponse.tasks.length !== expectedTaskCount) {
       log('warn', `Expected ${expectedTaskCount} tasks, but received ${parsedResponse.tasks.length}. Continuing anyway.`);
       // Decide if this should be a hard error or just a warning
       // throw new Error(`AI generated ${parsedResponse.tasks.length} tasks, but ${expectedTaskCount} were expected.`);
    }

    log('info', 'Successfully parsed JSON response from AI.');
    return parsedResponse;

  } catch (error) {
    log('error', 'Failed to parse JSON response from AI:', error.message);
    log('debug', 'Raw AI Response:', textContent);

    // Simple retry logic within processing (optional)
    if (retryCount < 1) { // Allow one retry specifically for parsing issues
      log('info', 'Attempting to re-process response...');
      // Potentially try cleaning the textContent more aggressively before parsing again
      // For now, just log and fail
    }

    console.error(chalk.red(`Error processing AI response: ${error.message}. Check logs for details.`));
    return null; // Indicate failure
  }
}

/**
 * Generate subtasks for a given task using OpenRouter AI
 * @param {Object} task - The parent task object
 * @param {number} numSubtasks - Number of subtasks to generate
 * @param {number} nextSubtaskId - Starting ID for subtasks
 * @param {string} additionalContext - Optional additional context
 * @returns {Promise<Object[]|null>} Array of subtask objects or null on failure
 */
async function generateSubtasks(task, numSubtasks, nextSubtaskId, additionalContext = '') {
  const loadingIndicator = startLoadingIndicator(`Generating ${numSubtasks} subtasks for Task ${task.id} using OpenRouter...`);
  try {
    const prompt = `Task: ${task.title} (ID: ${task.id})
Description: ${task.description}
Details: ${task.details || 'N/A'}
Priority: ${task.priority}
Dependencies: ${task.dependencies?.join(', ') || 'None'}
Test Strategy: ${task.testStrategy || 'N/A'}
${additionalContext ? `\nAdditional Context: ${additionalContext}` : ''}

Break this task down into exactly ${numSubtasks} smaller, actionable subtasks.
Each subtask should have:
- id: Starting from ${nextSubtaskId} (e.g., ${task.id}.${nextSubtaskId})
- title: Clear and concise title
- description: Brief description of the subtask
- status: "pending"
- dependencies: List any dependencies *within this set of subtasks* (using the new subtask IDs like ${task.id}.${nextSubtaskId}) or on the parent task's dependencies.
- priority: Inherit or adjust priority (high/medium/low)
- details: Specific implementation steps for the subtask
- testStrategy: How to verify this specific subtask

Respond ONLY with a valid JSON array of subtask objects, like this:
[
  { "id": "${task.id}.${nextSubtaskId}", "title": "...", "description": "...", ... },
  ...
]
Do not include any explanations or surrounding text.`;

    const systemPrompt = "You are an AI assistant specialized in breaking down development tasks into smaller, manageable subtasks. Follow the JSON output format precisely.";

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];

    log('debug', 'Calling OpenRouter for subtask generation with prompt:', prompt);

    const response = await openAI.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      temperature: CONFIG.temperature,
      messages: messages,
      response_format: { type: "json_object" }, // Request JSON output if model supports it
    });

    stopLoadingIndicator(loadingIndicator);

    const responseText = response.choices[0]?.message?.content;
    if (!responseText) {
      log('error', 'OpenRouter returned an empty response for subtask generation.');
      throw new Error('Empty response from OpenRouter');
    }

    log('debug', 'Raw response from OpenRouter (Subtasks):', responseText);

    // Parse the response using the dedicated function
    const parsedSubtasks = parseSubtasksFromText(responseText, nextSubtaskId, numSubtasks, task.id);

    if (!parsedSubtasks || parsedSubtasks.length === 0) {
       log('error', 'Failed to parse valid subtasks from OpenRouter response.');
       return null;
    }

    // Add parent task ID for context if needed by caller
    // parsedSubtasks.forEach(sub => sub.parentId = task.id);

    log('info', `Successfully generated ${parsedSubtasks.length} subtasks for Task ${task.id}.`);
    return parsedSubtasks;

  } catch (error) {
    stopLoadingIndicator(loadingIndicator);
    const userMessage = handleAIError(error, 'OpenRouter');
    log('error', `Failed to generate subtasks for Task ${task.id}: ${userMessage}`);
    console.error(chalk.red(`Error generating subtasks: ${userMessage}`));
    return null; // Indicate failure
  }
}

/* // Temporarily comment out Perplexity subtask generation
/**
 * Generate subtasks using Perplexity AI (Research-backed)
 * NOTE: This function remains largely unchanged as it uses the Perplexity client.
 * @param {Object} task - Parent task
 * @param {number} numSubtasks - Target number of subtasks
 * @param {number} nextSubtaskId - Starting subtask ID index
 * @param {string} additionalContext - Extra context
 * @returns {Promise<Object[]|null>} Array of subtasks or null on failure
 */
/*
async function generateSubtasksWithPerplexity(task, numSubtasks = 3, nextSubtaskId = 1, additionalContext = '') {
  // const loadingIndicator = startLoadingIndicator(`Researching and generating ${numSubtasks} subtasks for Task ${task.id} using Perplexity...`);
  // const perplexityClient = getPerplexityClient(); // Get initialized client

  // try {
      // ... (rest of the function body)
  // } catch (error) {
      // ... (error handling)
  // }
  console.warn("Perplexity integration is temporarily disabled.");
  log('warn', "Perplexity integration is temporarily disabled.");
  return null; // Return null as Perplexity is disabled
}
*/

/**
 * Parse subtasks from AI-generated text.
 * Tries to find and parse a JSON array within the text.
 * @param {string} text - Raw text response from AI
 * @param {number} startId - Expected starting index for subtask IDs
 * @param {number} expectedCount - Expected number of subtasks
 * @param {string|number} parentTaskId - ID of the parent task
 * @returns {Object[]|null} Array of parsed subtask objects or null
 */
function parseSubtasksFromText(text, startId, expectedCount, parentTaskId) {
  if (!text) return null;

  try {
    log('debug', `Attempting to parse subtasks from text. Expected ${expectedCount} starting at ${startId}. Parent: ${parentTaskId}`);
    let jsonString = '';

    // Try finding the JSON array directly
    const jsonArrayStart = text.indexOf('[');
    const jsonArrayEnd = text.lastIndexOf(']');

    if (jsonArrayStart !== -1 && jsonArrayEnd !== -1 && jsonArrayEnd > jsonArrayStart) {
      jsonString = text.substring(jsonArrayStart, jsonArrayEnd + 1);
      log('debug', 'Found JSON array structure `[...]`.');
    } else {
      // Fallback: Look for JSON object containing a 'subtasks' array
      const jsonObjectStart = text.indexOf('{');
      const jsonObjectEnd = text.lastIndexOf('}');
      if (jsonObjectStart !== -1 && jsonObjectEnd !== -1 && jsonObjectEnd > jsonObjectStart) {
         const potentialObject = JSON.parse(text.substring(jsonObjectStart, jsonObjectEnd + 1));
         if (potentialObject.subtasks && Array.isArray(potentialObject.subtasks)) {
            log('debug', 'Found JSON object structure `{"subtasks": [...]}`.');
            // Need to re-serialize the subtasks array to use JSON.parse safely later
            jsonString = JSON.stringify(potentialObject.subtasks);
         } else {
            log('warn', 'Found JSON object, but no "subtasks" array inside.');
            return null;
         }
      } else {
          log('warn', 'Could not find valid JSON array or object structure in AI response.');
          log('debug', 'Raw text for subtask parsing:', text);
          return null;
      }
    }

    const subtasks = JSON.parse(jsonString);

    if (!Array.isArray(subtasks)) {
      log('error', 'Parsed structure is not an array.');
      return null;
    }

    // Validate and format subtasks
    const validatedSubtasks = [];
    let currentSubId = startId;
    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      if (sub && typeof sub === 'object' && sub.title) {
         // Construct the expected ID format
         const expectedId = `${parentTaskId}.${currentSubId}`;

         // Overwrite or assign the correct ID format
         sub.id = expectedId;

         // Ensure required fields exist (add defaults if necessary)
         sub.description = sub.description || `Subtask for ${sub.title}`;
         sub.status = sub.status || 'pending';
         sub.dependencies = sub.dependencies || [];
         sub.priority = sub.priority || 'medium';
         sub.details = sub.details || 'Implement this subtask.';
         sub.testStrategy = sub.testStrategy || 'Verify functionality.';

         validatedSubtasks.push(sub);
         currentSubId++; // Increment for the next expected ID
      } else {
         log('warn', `Skipping invalid subtask structure at index ${i}:`, sub);
      }
    }


    if (validatedSubtasks.length !== expectedCount) {
      log('warn', `Expected ${expectedCount} subtasks, but parsed ${validatedSubtasks.length}.`);
      // Decide whether to return partial results or fail
      if (validatedSubtasks.length === 0) return null; // Fail if none parsed
    }

    log('info', `Successfully parsed ${validatedSubtasks.length} subtasks.`);
    return validatedSubtasks;

  } catch (error) {
    log('error', 'Error parsing subtasks JSON:', error.message);
    log('debug', 'Text content during parsing error:', text);
    return null;
  }
}

/**
 * Generates the prompt for task complexity analysis using OpenRouter.
 * @param {Array<Object>} tasksData - Array of task objects
 * @returns {string} The system prompt for complexity analysis
 */
function generateComplexityAnalysisPrompt(tasksData) {
  const taskDescriptions = tasksData.map(task =>
    `- Task ${task.id}: ${task.title} (Deps: ${task.dependencies.join(', ') || 'None'}) - ${task.description}`
  ).join('\n');

  return `You are an AI assistant specialized in analyzing software development task complexity.
Analyze the following tasks and provide a complexity score (1-10) for each, along with a brief justification and a recommendation for the number of subtasks if complexity is high (>= 5).

Tasks:
${taskDescriptions}

Complexity Scale:
1-2: Trivial (e.g., config change, simple UI update)
3-4: Simple (e.g., small feature, standard component)
5-7: Medium (e.g., complex feature, integration, some unknowns)
8-9: High (e.g., core system change, major refactor, high uncertainty)
10: Very High (e.g., requires significant research, architectural changes, many unknowns)

Output Format:
Respond ONLY with a valid JSON object containing a single key "complexityAnalysis", which is an array. Each element in the array should be an object with the following keys:
- taskId: number
- title: string
- complexityScore: number (1-10)
- justification: string (brief explanation for the score)
- recommendedSubtasks: number (suggested number of subtasks, 0 if score < 5)

Example JSON Output:
{
  "complexityAnalysis": [
    { "taskId": 1, "title": "Setup Project", "complexityScore": 3, "justification": "Standard setup.", "recommendedSubtasks": 0 },
    { "taskId": 2, "title": "Implement Auth", "complexityScore": 7, "justification": "Involves external service integration and security.", "recommendedSubtasks": 5 },
    ...
  ]
}

Ensure the output is only the JSON object, nothing else.`;
}

// Export the necessary functions
export {
  generateTasksFromPRD,
  generateSubtasks,
  // generateSubtasksWithPerplexity, // Comment out export
  // getPerplexityClient, // Comment out export
  generateComplexityAnalysisPrompt,
  processAIResponse,
  parseSubtasksFromText,
  handleStreamingRequest,
};

// Removed duplicated TODOs below this line