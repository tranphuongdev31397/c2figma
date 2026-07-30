const NODE_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['box', 'text'] },
          name: {
            type: 'string',
            description: 'Semantic label: "Button / Submit", "Card / Product", "Text / Hello" — not "div1"'
          },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: {
            type: ['string', 'null'],
            description: 'Hex color, e.g. #FF5733, or null if transparent'
          },
          stroke: { type: ['string', 'null'] },
          strokeWidth: { type: 'number' },
          radius: { type: 'number' },
          text: { type: 'string' },
          fontSize: { type: 'number' },
          fontWeight: { type: 'number', enum: [400, 500, 600, 700] },
          color: { type: ['string', 'null'] }
        },
        required: [
          'id', 'parentId', 'kind', 'name', 'x', 'y', 'width', 'height',
          'fill', 'stroke', 'strokeWidth', 'radius', 'text', 'fontSize',
          'fontWeight', 'color'
        ],
        additionalProperties: false
      }
    }
  },
  required: ['nodes'],
  additionalProperties: false
};

module.exports = { NODE_SCHEMA };
