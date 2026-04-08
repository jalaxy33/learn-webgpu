import GUI from "https://webgpufundamentals.org/3rdparty/muigui-0.x.module.js";

// A random number between [min and max)
// With 1 argument it will be [0 to min)
// With no arguments it will be [0 to 1)
const rand = (min, max) => {
  if (min === undefined) {
    min = 0;
    max = 1;
  } else if (max === undefined) {
    max = min;
    min = 0;
  }
  return min + Math.random() * (max - min);
};

function createCircleVertices({
  radius = 1,
  numSubdivisions = 24,
  innerRadius = 0,
  startAngle = 0,
  endAngle = Math.PI * 2,
} = {}) {
  // 2 vertices at each subdivision, + 1 to wrap around the circle.
  const numVertices = (numSubdivisions + 1) * 2;
  // 2 32-bit values for position (xy) and 1 32-bit value for color (rgb_)
  // The 32-bit color value will be written/read as 4 8-bit values
  const vertexData = new Float32Array(numVertices * (2 + 1));
  const colorData = new Uint8Array(vertexData.buffer);

  let offset = 0;
  let colorOffset = 8;
  const addVertex = (x, y, r, g, b) => {
    vertexData[offset++] = x;
    vertexData[offset++] = y;
    offset += 1; // skip the color
    colorData[colorOffset++] = r * 255;
    colorData[colorOffset++] = g * 255;
    colorData[colorOffset++] = b * 255;
    colorOffset += 9; // skip extra byte and the position
  };

  const innerColor = [1, 1, 1];
  const outerColor = [0.1, 0.1, 0.1];

  // 2 triangles per subdivision
  //
  // 0  2  4  6  8 ...
  //
  // 1  3  5  7  9 ...
  for (let i = 0; i <= numSubdivisions; ++i) {
    const angle =
      startAngle + ((i + 0) * (endAngle - startAngle)) / numSubdivisions;

    const c1 = Math.cos(angle);
    const s1 = Math.sin(angle);

    addVertex(c1 * radius, s1 * radius, ...outerColor);
    addVertex(c1 * innerRadius, s1 * innerRadius, ...innerColor);
  }

  const indexData = new Uint32Array(numSubdivisions * 6);
  let ndx = 0;

  // 1st tri  2nd tri  3rd tri  4th tri
  // 0 1 2    2 1 3    2 3 4    4 3 5
  //
  // 0--2        2     2--4        4  .....
  // | /        /|     | /        /|
  // |/        / |     |/        / |
  // 1        1--3     3        3--5  .....
  for (let i = 0; i < numSubdivisions; ++i) {
    const ndxOffset = i * 2;

    // first triangle
    indexData[ndx++] = ndxOffset;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 2;

    // second triangle
    indexData[ndx++] = ndxOffset + 2;
    indexData[ndx++] = ndxOffset + 1;
    indexData[ndx++] = ndxOffset + 3;
  }

  return {
    vertexData,
    indexData,
    numVertices: indexData.length,
  };
}

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const canTimestamp = adapter.features.has("timestamp-query");
  const device = await adapter?.requestDevice({
    requiredFeatures: [...(canTimestamp ? ["timestamp-query"] : [])],
  });
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  // Get a WebGPU context from the canvas and configure it
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("webgpu");
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
  });

  // Create a shader module
  const module = device.createShaderModule({
    label: "our hardcoded red triangle shaders",
    code: /* wgsl */ `
      // vertices of triangles 
      //  pass values from vertex buffer
      struct Vertex {
        @location(0) position: vec2f,  
        @location(1) color: vec4f,
        @location(2) offset: vec2f,
        @location(3) scale: vec2f,
        @location(4) perVertexColor: vec4f,
      };

      struct VSOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
      }

      @vertex fn vs(
        vert: Vertex, 
      ) -> VSOutput {
        var vsOut: VSOutput;
        vsOut.position = vec4f(
            vert.position * vert.scale + vert.offset, 0.0, 1.0);
        vsOut.color = vert.color * vert.perVertexColor;
        return vsOut;
      }
 
      @fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
        return vsOut.color;
      }
    `,
  });

  // Create a render pipeline
  const pipeline = device.createRenderPipeline({
    label: "our hardcoded red triangle pipeline",
    layout: "auto",
    vertex: {
      //   entryPoint: "vs",
      module,
      // [vertex buffer layouts]
      buffers: [
        // #0: buffer for vertex attributes
        {
          arrayStride: 2 * 4 + 4, // 2 floats, 4 bytes each + 4 bytes
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
            { shaderLocation: 4, offset: 8, format: "unorm8x4" }, // perVertexColor
          ],
        },
        // #1: buffer for static values
        {
          arrayStride: 4, // 4 bytes
          stepMode: "instance", // step per instance (default: 'vertex')
          attributes: [
            { shaderLocation: 1, offset: 0, format: "unorm8x4" }, // color
          ],
        },
        // #2: buffer for changing values
        {
          arrayStride: 4 * 4, // 4 floats, 4 bytes each
          stepMode: "instance", // step per instance (default: 'vertex')
          attributes: [
            { shaderLocation: 2, offset: 0, format: "float32x2" }, // offset
            { shaderLocation: 3, offset: 8, format: "float32x2" }, // scale
          ],
        },
      ],
    },
    fragment: {
      //   entryPoint: "fs",
      module,
      targets: [{ format: presentationFormat }],
    },
  });

  const kNumObjects = 10000;
  const objectInfos = [];

  // create 2 vertex buffers
  const staticUnitSize = 4; // color is 4 bytes
  const changingUnitSize =
    2 * 4 + // offset is 2 32bit floats (4bytes each)
    2 * 4; // scale is 2 32bit floats (4bytes each)
  const staticVertexBufferSize = staticUnitSize * kNumObjects;
  const changingVertexBufferSize = changingUnitSize * kNumObjects;

  const staticVertexBuffer = device.createBuffer({
    label: "static vertex for objects",
    size: staticVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const changingVertexBuffer = device.createBuffer({
    label: "changing vertex for objects",
    size: changingVertexBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  // offsets to the various uniform values in float32 indices
  const kColorOffset = 0;

  const kOffsetOffset = 0;
  const kScaleOffset = 2;

  {
    const staticVertexValuesU8 = new Uint8Array(staticVertexBufferSize);
    for (let i = 0; i < kNumObjects; ++i) {
      const staticOffsetU8 = i * staticUnitSize;

      // These are only set once so set them now
      staticVertexValuesU8.set(
        // set the color
        [rand() * 255, rand() * 255, rand() * 255, 255],
        staticOffsetU8 + kColorOffset,
      );

      objectInfos.push({
        scale: rand(0.2, 0.5),
        offset: [rand(-0.9, 0.9), rand(-0.9, 0.9)],
        velocity: [rand(-0.1, 0.1), rand(-0.1, 0.1)],
      });
    }
    device.queue.writeBuffer(staticVertexBuffer, 0, staticVertexValuesU8);
  }

  // a typed array we can use to update the changingVertexBuffer
  const vertexValues = new Float32Array(changingVertexBufferSize / 4);

  // Create shapes
  const { vertexData, indexData, numVertices } = createCircleVertices({
    radius: 0.5,
    innerRadius: 0.25,
  });

  // Create vertex buffer
  const vertexBuffer = device.createBuffer({
    label: "vertex buffer vertices",
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // Create index buffer
  const indexBuffer = device.createBuffer({
    label: "index buffer",
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  // Prepare a render pass descriptor
  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  const infoElem = document.querySelector("#info");

  const settings = {
    numObjects: 100,
  };

  const gui = new GUI();
  gui.add(settings, "numObjects", 0, kNumObjects, 1);

  const euclideanModulo = (x, a) => x - a * Math.floor(x / a);

  let then = 0;

  // render pass
  function render(now) {
    now *= 0.001; // convert to seconds
    const deltaTime = now - then;
    then = now;

    const startTime = performance.now();

    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    renderPassDescriptor.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    // make a command encoder to start encoding commands
    const encoder = device.createCommandEncoder({ label: "our encoder" });

    // make a render pass encoder to encode render specific commands
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer); // #0 element of pipeline
    pass.setVertexBuffer(1, staticVertexBuffer); // #1
    pass.setVertexBuffer(2, changingVertexBuffer); // #2
    pass.setIndexBuffer(indexBuffer, "uint32");

    // Set the uniform values in our JavaScript side Float32Array
    const aspect = canvas.width / canvas.height;

    // set the scales for each object
    for (let ndx = 0; ndx < settings.numObjects; ++ndx) {
      const { scale, offset, velocity } = objectInfos[ndx];

      // -1.5 to 1.5
      offset[0] =
        euclideanModulo(offset[0] + velocity[0] * deltaTime + 1.5, 3) - 1.5;
      offset[1] =
        euclideanModulo(offset[1] + velocity[1] * deltaTime + 1.5, 3) - 1.5;

      const off = ndx * (changingUnitSize / 4);
      vertexValues.set(offset, off + kOffsetOffset);
      vertexValues.set([scale / aspect, scale], off + kScaleOffset);
    }

    // upload all offsets and scales at once
    device.queue.writeBuffer(
      changingVertexBuffer,
      0,
      vertexValues,
      0,
      (settings.numObjects * changingUnitSize) / 4,
    );

    pass.drawIndexed(numVertices, settings.numObjects); // use 'drawIndexed' instead of 'draw'
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    const jsTime = performance.now() - startTime;

    infoElem.textContent = `\
fps: ${(1 / deltaTime).toFixed(1)}
js: ${jsTime.toFixed(1)}ms
`;

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // re-render when the canvas resizes
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const canvas = entry.target;
      const width = entry.contentBoxSize[0].inlineSize;
      const height = entry.contentBoxSize[0].blockSize;
      canvas.width = Math.max(
        1,
        Math.min(width, device.limits.maxTextureDimension2D),
      );
      canvas.height = Math.max(
        1,
        Math.min(height, device.limits.maxTextureDimension2D),
      );
    }
  });
  observer.observe(canvas);
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
