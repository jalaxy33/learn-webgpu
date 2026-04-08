import GUI from "https://webgpufundamentals.org/3rdparty/muigui-0.x.module.js";

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
    alphaMode: "premultiplied",  // change to "opaque" to disable alpha blending
  });

  const clearValue = [1, 0, 0, 0.01];
  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        clearValue,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  const color = [1, 0, 0];
  const settings = {
    premultiply: false,
    color,
    alpha: 0.01,
  };

  const gui = new GUI().onChange(render);
  gui.add(settings, "premultiply");
  gui.add(settings, "alpha", 0, 1);
  gui.addColor(settings, "color");

  function render() {
    const encoder = device.createCommandEncoder({ label: "clear encoder" });
    const canvasTexture = context.getCurrentTexture();
    renderPassDescriptor.colorAttachments[0].view = canvasTexture.createView();

    const { alpha } = settings;
    clearValue[3] = alpha;
    if (settings.premultiply) {
      // premultiply the colors by the alpha
      clearValue[0] = color[0] * alpha;
      clearValue[1] = color[1] * alpha;
      clearValue[2] = color[2] * alpha;
    } else {
      // use un-premultiplied colors
      clearValue[0] = color[0];
      clearValue[1] = color[1];
      clearValue[2] = color[2];
    }

    const pass = encoder.beginRenderPass(renderPassDescriptor);
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
      render();
    }
  });
  observer.observe(canvas);
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

main();
