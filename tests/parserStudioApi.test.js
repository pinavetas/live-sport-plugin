'use strict';

const parserStudioRouter = require('../src/routes/parserStudio');
const dynamicParserRegistry = require('../src/services/DynamicParserRegistry');

describe('Parser Studio REST API handlers', () => {
  test('rejects POST /generate without valid URL', async () => {
    const generateRoute = parserStudioRouter.stack.find(r => r.route && r.route.path === '/generate').route;
    const handler = generateRoute.stack[0].handle;

    const req = { body: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('lists saved custom parsers on GET /list', () => {
    const listRoute = parserStudioRouter.stack.find(r => r.route && r.route.path === '/list').route;
    const handler = listRoute.stack[0].handle;

    jest.spyOn(dynamicParserRegistry, 'listParsers').mockReturnValueOnce([
      { id: 'custom1', name: 'custom1', displayName: 'Custom 1' }
    ]);

    const req = {};
    const res = { json: jest.fn() };

    handler(req, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      parsers: [expect.objectContaining({ name: 'custom1' })]
    });
  });

  test('handles DELETE /:name for non-existent parser with 404', () => {
    const deleteRoute = parserStudioRouter.stack.find(r => r.route && r.route.path === '/:name').route;
    const handler = deleteRoute.stack[0].handle;

    jest.spyOn(dynamicParserRegistry, 'deleteParser').mockReturnValueOnce({
      success: false,
      error: 'Parser not found'
    });

    const req = { params: { name: 'unknown' }, app: { get: () => null } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
