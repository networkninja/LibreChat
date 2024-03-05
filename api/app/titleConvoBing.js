const throttle = require('lodash/throttle');
const { isEnabled } = require('~/server/utils');
const { logger } = require('~/config');

const titleConvo = async ({ text, response }) => {
  let title = 'New Chat';
  const { TITLE_CONVO = 'true' } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return title;
  }

  const { BingAIClient } = await import('nodejs-gpt');
  const titleGenerator = new BingAIClient({
    userToken: process.env.BINGAI_TOKEN,
    debug: false,
  });

  let options = {
    jailbreakConversationId: true,
    systemMessage:
    "You are a title-generator. Your task is to generate an extremely concise title for this conversation in English, regardless of the user's language. The title should be in 5 Words or Less, with no punctuation or quotation marks. All first letters of every word should be capitalized.",
    context: `
      ||>User:
      "${text}"
      ||>Response:
      "${JSON.stringify(response?.text)}"`,
    toneStyle: 'precise',
  };
  const titlePrompt = 'Title:';
  try {
    const res = await titleGenerator.sendMessage(titlePrompt, options);
    title = res.response.replace(/Title: /, '').replace(/[".]/g, '');
  } catch (e) {
    logger.error('There was an issue generating title with BingAI', e);
  }

  logger.debug('[/ask/bingAI] CONVERSATION TITLE: ' + title);
  return title;
};

const throttledTitleConvo = throttle(titleConvo, 3000);

module.exports = throttledTitleConvo;
