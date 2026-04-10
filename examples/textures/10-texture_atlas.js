import GUI from "https://webgpufundamentals.org/3rdparty/muigui-0.x.module.js";
import { mat4 } from "https://webgpufundamentals.org/3rdparty/wgpu-matrix.module.js";

function createCubeVertices() {
  // prettier-ignore
  const vertexData = new Float32Array([
     //  position   |  texture coordinate
     //-------------+----------------------
     // front face     select the top left image
    -1,  1,  1,        0   , 0  ,
    -1, -1,  1,        0   , 0.5,
     1,  1,  1,        0.25, 0  ,
     1, -1,  1,        0.25, 0.5,
     // right face     select the top middle image
     1,  1, -1,        0.25, 0  ,
     1,  1,  1,        0.5 , 0  ,
     1, -1, -1,        0.25, 0.5,
     1, -1,  1,        0.5 , 0.5,
     // back face      select to top right image
     1,  1, -1,        0.5 , 0  ,
     1, -1, -1,        0.5 , 0.5,
    -1,  1, -1,        0.75, 0  ,
    -1, -1, -1,        0.75, 0.5,
    // left face       select the bottom left image
    -1,  1,  1,        0   , 0.5,
    -1,  1, -1,        0.25, 0.5,
    -1, -1,  1,        0   , 1  ,
    -1, -1, -1,        0.25, 1  ,
    // bottom face     select the bottom middle image
     1, -1,  1,        0.25, 0.5,
    -1, -1,  1,        0.5 , 0.5,
     1, -1, -1,        0.25, 1  ,
    -1, -1, -1,        0.5 , 1  ,
    // top face        select the bottom right image
    -1,  1,  1,        0.5 , 0.5,
     1,  1,  1,        0.75, 0.5,
    -1,  1, -1,        0.5 , 1  ,
     1,  1, -1,        0.75, 1  ,
 
  ]);

  // prettier-ignore
  const indexData = new Uint16Array([
     0,  1,  2,  2,  1,  3,  // front
     4,  5,  6,  6,  5,  7,  // right
     8,  9, 10, 10,  9, 11,  // back
    12, 13, 14, 14, 13, 15,  // left
    16, 17, 18, 18, 17, 19,  // bottom
    20, 21, 22, 22, 21, 23,  // top
  ]);

  return {
    vertexData,
    indexData,
    numVertices: indexData.length,
  };
}

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
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
    alphaMode: "premultiplied",
  });

  const module = device.createShaderModule({
    code: /* wgsl */ `
        struct Uniforms {
          matrix: mat4x4f,
        };

        struct Vertex {
          @location(0) position: vec4f,
          @location(1) texcoord: vec2f,
        };

        struct VSOutput {
          @builtin(position) position: vec4f,
          @location(0) texcoord: vec2f,
        };

        @group(0) @binding(0) var<uniform> uni: Uniforms;
        @group(0) @binding(1) var ourSampler: sampler;
        @group(0) @binding(2) var ourTexture: texture_2d<f32>;

        @vertex fn vs(vert: Vertex) -> VSOutput {
          var vsOut: VSOutput;
          vsOut.position = uni.matrix * vert.position;
          vsOut.texcoord = vert.texcoord;
        return vsOut;
        }

        @fragment fn fs(vsOut: VSOutput) -> @location(0) vec4f {
          return textureSample(ourTexture, ourSampler, vsOut.texcoord);
        }
    `,
  });

  const pipeline = device.createRenderPipeline({
    label: "2 attributes",
    layout: "auto",
    vertex: {
      module,
      buffers: [
        {
          arrayStride: (3 + 2) * 4, // (3+2) floats 4 bytes each
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
            { shaderLocation: 1, offset: 12, format: "float32x2" }, // texcoord
          ],
        },
      ],
    },
    fragment: {
      module,
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      cullMode: "back",
    },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: "less",
      format: "depth24plus",
    },
  });

  const numMipLevels = (...sizes) => {
    const maxSize = Math.max(...sizes);
    return (1 + Math.log2(maxSize)) | 0;
  };

  async function loadImageBitmap(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob, {
      colorSpaceConversion: "none", // tell the browser not to apply any color space
    });
  }

  function copySourceToTexture(device, texture, source, { flipY } = {}) {
    // copyExternalImageToTexture copy data to mip level 0,
    // but the rest of the mip levels won't be filled in until we call generateMips.
    device.queue.copyExternalImageToTexture(
      { source, flipY },
      { texture },
      { width: source.width, height: source.height },
    );

    if (texture.mipLevelCount > 1) {
      generateMips(device, texture);
    }
  }

  function createTextureFromSource(device, source, options = {}) {
    const texture = device.createTexture({
      format: "rgba8unorm",
      mipLevelCount: options.mips
        ? numMipLevels(source.width, source.height)
        : 1,
      size: [source.width, source.height],
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    copySourceToTexture(device, texture, source, options);
    return texture;
  }

  async function createTextureFromImage(device, url, options) {
    const imgBitmap = await loadImageBitmap(url);
    return createTextureFromSource(device, imgBitmap, options);
  }

  // Generate Mipmap manually on GPU
  const generateMips = (() => {
    let sampler;
    let module;
    const pipelineByFormat = {};

    return function generateMips(device, texture) {
      if (!module) {
        module = device.createShaderModule({
          label: "textured quad shaders for mip level generation",
          code: /* wgsl */ `
            struct VSOutput {
              @builtin(position) position: vec4f,
              @location(0) texcoord: vec2f,
            };
 
            @vertex fn vs(
              @builtin(vertex_index) vertexIndex : u32
            ) -> VSOutput {
              let pos = array(
                // 1st triangle
                vec2f( 0.0,  0.0),  // center
                vec2f( 1.0,  0.0),  // right, center
                vec2f( 0.0,  1.0),  // center, top
 
                // 2nd triangle
                vec2f( 0.0,  1.0),  // center, top
                vec2f( 1.0,  0.0),  // right, center
                vec2f( 1.0,  1.0),  // right, top
              );
 
              var vsOutput: VSOutput;
              let xy = pos[vertexIndex];

              // cover the whole area rather than just the hardcoded top right corner
              vsOutput.position = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
              vsOutput.texcoord = vec2f(xy.x, 1.0 - xy.y);
              return vsOutput;
            }
 
            @group(0) @binding(0) var ourSampler: sampler;
            @group(0) @binding(1) var ourTexture: texture_2d<f32>;
 
            @fragment fn fs(fsInput: VSOutput) -> @location(0) vec4f {
              return textureSample(ourTexture, ourSampler, fsInput.texcoord);
            }
          `,
        });

        sampler = device.createSampler({
          minFilter: "linear",
          magFilter: "linear",
        });
      }

      if (!pipelineByFormat[texture.format]) {
        pipelineByFormat[texture.format] = device.createRenderPipeline({
          label: "mip level generator pipeline",
          layout: "auto",
          vertex: {
            module,
          },
          fragment: {
            module,
            targets: [{ format: texture.format }],
          },
        });
      }
      const pipeline = pipelineByFormat[texture.format];

      const encoder = device.createCommandEncoder({
        label: "mip gen encoder",
      });

      // start from mip level 1 since level 0 is already filled by copyExternalImageToTexture
      for (
        let baseMipLevel = 1;
        baseMipLevel < texture.mipLevelCount;
        ++baseMipLevel
      ) {
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler }, // bind the sampler
            {
              binding: 1,
              resource: texture.createView({
                baseMipLevel: baseMipLevel - 1, // bind the previous mip level as the source texture
                mipLevelCount: 1,
              }),
            },
          ],
        });

        const renderPassDescriptor = {
          label: "our basic canvas renderPass",
          colorAttachments: [
            {
              view: texture.createView({
                baseMipLevel, // use current mip level as the render target for this pass
                mipLevelCount: 1,
              }),
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        };

        const pass = encoder.beginRenderPass(renderPassDescriptor);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(6); // call our vertex shader 6 times
        pass.end();
      }
      const commandBuffer = encoder.finish();
      device.queue.submit([commandBuffer]);
    };
  })();

  // matrix
  const uniformBufferSize = 16 * 4;
  const uniformBuffer = device.createBuffer({
    label: "uniforms",
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uniformValues = new Float32Array(uniformBufferSize / 4);

  // offsets to the various uniform values in float32 indices
  const kMatrixOffset = 0;

  const matrixValue = uniformValues.subarray(kMatrixOffset, kMatrixOffset + 16);

  const texture = await createTextureFromImage(
    device,
    "https://webgpufundamentals.org/webgpu/resources/images/noodles.jpg",
    { mips: true, flipY: false },
  );

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });

  const bindGroup = device.createBindGroup({
    label: "bind group for object",
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: uniformBuffer },
      { binding: 1, resource: sampler },
      { binding: 2, resource: texture },
    ],
  });

  const { vertexData, indexData, numVertices } = createCubeVertices();
  const vertexBuffer = device.createBuffer({
    label: "vertex buffer vertices",
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  const indexBuffer = device.createBuffer({
    label: "index buffer",
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      // view: <- to be filled out when we render
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  };

  const degToRad = (d) => (d * Math.PI) / 180;

  const settings = {
    rotation: [degToRad(20), degToRad(25), degToRad(0)],
  };

  const radToDegOptions = {
    min: -360,
    max: 360,
    step: 1,
    converters: GUI.converters.radToDeg,
  };

  const gui = new GUI();
  gui.onChange(render);
  gui.add(settings.rotation, "0", radToDegOptions).name("rotation.x");
  gui.add(settings.rotation, "1", radToDegOptions).name("rotation.y");
  gui.add(settings.rotation, "2", radToDegOptions).name("rotation.z");

  let depthTexture;

  function render() {
    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    const canvasTexture = context.getCurrentTexture();
    renderPassDescriptor.colorAttachments[0].view = canvasTexture.createView();

    // If we don't have a depth texture OR if its size is different
    // from the canvasTexture when make a new depth texture
    if (
      !depthTexture ||
      depthTexture.width !== canvasTexture.width ||
      depthTexture.height !== canvasTexture.height
    ) {
      if (depthTexture) {
        depthTexture.destroy();
      }
      depthTexture = device.createTexture({
        size: [canvasTexture.width, canvasTexture.height],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    renderPassDescriptor.depthStencilAttachment.view =
      depthTexture.createView();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint16");

    const aspect = canvas.clientWidth / canvas.clientHeight;
    mat4.perspective(
      (60 * Math.PI) / 180,
      aspect,
      0.1, // zNear
      10, // zFar
      matrixValue,
    );
    const view = mat4.lookAt(
      [0, 1, 5], // camera position
      [0, 0, 0], // target
      [0, 1, 0], // up
    );
    mat4.multiply(matrixValue, view, matrixValue);
    mat4.rotateX(matrixValue, settings.rotation[0], matrixValue);
    mat4.rotateY(matrixValue, settings.rotation[1], matrixValue);
    mat4.rotateZ(matrixValue, settings.rotation[2], matrixValue);

    // upload the uniform values to the uniform buffer
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
    pass.setBindGroup(0, bindGroup);
    pass.drawIndexed(numVertices);

    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }

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
      // re-render
      render();
    }
  });
  observer.observe(canvas);
}

function fail(msg) {
  alert(msg);
}

main();
