'use strict';

const { processSlug } = require('../../lib/handler');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  // Support both /api/data/[slug] and rewrite /data/:slug
  const slug = req.query.slug || (req.url && req.url.split('/').pop());

  const debug = req.query.debug === 'true';

  try {
    const result = await processSlug(slug);
    if (debug) {
      return res.status(200).send(
        `OK\nRedirect: ${result.redirectUrl}\n` +
          `Error: ${result.error || 'none'}\nSolana: ${result.solCount}\nBNB: ${result.bnbCount}`,
      );
    }
    return res.redirect(302, result.redirectUrl);
  } catch (err) {
    console.error('[handler]', err.message);
    if (debug) return res.status(err.statusCode || 500).send(`ERROR ${err.message}`);
    return res.redirect(302, 'https://axiom.trade');
  }
};
