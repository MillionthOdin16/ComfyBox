import { LiteGraph, LGraph, LGraphNode } from "@litegraph-ts/core"
import type ComfyAPI from "$lib/api"

class PNGMetadataPromise extends Promise<Record<string, string>> {
    public cancelMethod: () => void;
    constructor(executor: (resolve: (value?: Record<string, string>) => void, reject: (reason?: any) => void) => void) {
        super(executor);

    }

    //cancel the operation
    public cancel() {
        if (this.cancelMethod) {
            this.cancelMethod();
        }
    }
}

export function getPngMetadata(file: File): PNGMetadataPromise {
    return new PNGMetadataPromise((r, _) => {
        const reader = new FileReader();
        reader.onload = (event: Event) => {
            // Get the PNG data as a Uint8Array
            const pngData = new Uint8Array((event.target as any).result);
            const dataView = new DataView(pngData.buffer);

            // Check that the PNG signature is present
            if (dataView.getUint32(0) !== 0x89504e47) {
                console.error("Not a valid PNG file");
                r();
                return;
            }

            // Start searching for chunks after the PNG signature
            let offset = 8;
            let txt_chunks = {};
            // Loop through the chunks in the PNG file
            while (offset < pngData.length) {
                // Get the length of the chunk
                const length = dataView.getUint32(offset);
                // Get the chunk type
                const type = String.fromCharCode(...pngData.slice(offset + 4, offset + 8));
                if (type === "tEXt") {
                    // Get the keyword
                    let keyword_end = offset + 8;
                    while (pngData[keyword_end] !== 0) {
                        keyword_end++;
                    }
                    const keyword = String.fromCharCode(...pngData.slice(offset + 8, keyword_end));
                    // Get the text
                    const text = String.fromCharCode(...pngData.slice(keyword_end + 1, offset + 8 + length));
                    txt_chunks[keyword] = text;
                }

                offset += 12 + length;
            }

            r(txt_chunks);
        };

        reader.readAsArrayBuffer(file);
    });
}

type NodeIndex = { node: LGraphNode, index: number }

export async function importA1111(graph: LGraph, parameters: string, api: ComfyAPI) {
    const p = parameters.lastIndexOf("\nSteps:");
    if (p > -1) {
        const embeddings = await api.getEmbeddings();
        const opts = parameters
            .substr(p)
            .split(",")
            .reduce((p, n) => {
                const s = n.split(":");
                p[s[0].trim().toLowerCase()] = s[1].trim();
                return p;
            }, {});
        const p2 = parameters.lastIndexOf("\nNegative prompt:", p);
        if (p2 > -1) {
            let positive = parameters.substr(0, p2).trim();
            let negative = parameters.substring(p2 + 18, p).trim();

            const ckptNode = LiteGraph.createNode("CheckpointLoaderSimple");
            const clipSkipNode = LiteGraph.createNode("CLIPSetLastLayer");
            const positiveNode = LiteGraph.createNode("CLIPTextEncode");
            const negativeNode = LiteGraph.createNode("CLIPTextEncode");
            const samplerNode = LiteGraph.createNode("KSampler");
            const imageNode = LiteGraph.createNode("EmptyLatentImage");
            const vaeNode = LiteGraph.createNode("VAEDecode");
            const vaeLoaderNode = LiteGraph.createNode("VAELoader");
            const saveNode = LiteGraph.createNode("SaveImage");
            let hrSamplerNode = null;

            const ceil64 = (v) => Math.ceil(v / 64) * 64;

            function getWidget(node: LGraphNode, name: string) {
                return node.widgets.find((w) => w.name === name);
            }

            function setWidgetValue(node: LGraphNode, name: string, value: any, isOptionPrefix: boolean = false) {
                const w = getWidget(node, name);
                if (isOptionPrefix) {
                    const o = w.options.values.find((w) => w.startsWith(value));
                    if (o) {
                        w.value = o;
                    } else {
                        console.warn(`Unknown value '${value}' for widget '${name}'`, node);
                        w.value = value;
                    }
                } else {
                    w.value = value;
                }
            }

            function createLoraNodes(clipNode: LGraphNode, text: string, prevClip: NodeIndex, prevModel: NodeIndex) {
                const loras = [];
                text = text.replace(/<lora:([^:]+:[^>]+)>/g, function(m, c) {
                    const s = c.split(":");
                    const weight = parseFloat(s[1]);
                    if (isNaN(weight)) {
                        console.warn("Invalid LORA", m);
                    } else {
                        loras.push({ name: s[0], weight });
                    }
                    return "";
                });

                for (const l of loras) {
                    const loraNode = LiteGraph.createNode("LoraLoader");
                    graph.add(loraNode);
                    setWidgetValue(loraNode, "lora_name", l.name, true);
                    setWidgetValue(loraNode, "strength_model", l.weight);
                    setWidgetValue(loraNode, "strength_clip", l.weight);
                    prevModel.node.connect(prevModel.index, loraNode, 0);
                    prevClip.node.connect(prevClip.index, loraNode, 1);
                    prevModel = { node: loraNode, index: 0 };
                    prevClip = { node: loraNode, index: 1 };
                }

                prevClip.node.connect(1, clipNode, 0);
                prevModel.node.connect(0, samplerNode, 0);
                if (hrSamplerNode) {
                    prevModel.node.connect(0, hrSamplerNode, 0);
                }

                return { text, prevModel, prevClip };
            }

            function replaceEmbeddings(text: string) {
                return text.replaceAll(
                    new RegExp(
                        "\\b(" + embeddings.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\b|\\b") + ")\\b",
                        "ig"
                    ),
                    "embedding:$1"
                );
            }

            function popOpt(name: string) {
                const v = opts[name];
                delete opts[name];
                return v;
            }

            graph.clear();
            graph.add(ckptNode);
            graph.add(clipSkipNode);
            graph.add(positiveNode);
            graph.add(negativeNode);
            graph.add(samplerNode);
            graph.add(imageNode);
            graph.add(vaeNode);
            graph.add(vaeLoaderNode);
            graph.add(saveNode);

            ckptNode.connect(1, clipSkipNode, 0);
            clipSkipNode.connect(0, positiveNode, 0);
            clipSkipNode.connect(0, negativeNode, 0);
            ckptNode.connect(0, samplerNode, 0);
            positiveNode.connect(0, samplerNode, 1);
            negativeNode.connect(0, samplerNode, 2);
            imageNode.connect(0, samplerNode, 3);
            vaeNode.connect(0, saveNode, 0);
            samplerNode.connect(0, vaeNode, 0);
            vaeLoaderNode.connect(0, vaeNode, 1);

            const handlers = {
                model(v: string) {
                    setWidgetValue(ckptNode, "ckpt_name", v, true);
                },
                "cfg scale"(v: number) {
                    setWidgetValue(samplerNode, "cfg", +v);
                },
                "clip skip"(v: number) {
                    setWidgetValue(clipSkipNode, "stop_at_clip_layer", -v);
                },
                sampler(v: string) {
                    let name = v.toLowerCase().replace("++", "pp").replaceAll(" ", "_");
                    if (name.includes("karras")) {
                        name = name.replace("karras", "").replace(/_+$/, "");
                        setWidgetValue(samplerNode, "scheduler", "karras");
                    } else {
                        setWidgetValue(samplerNode, "scheduler", "normal");
                    }
                    const w = getWidget(samplerNode, "sampler_name");
                    const o = w.options.values.find((w) => w === name || w === "sample_" + name);
                    if (o) {
                        setWidgetValue(samplerNode, "sampler_name", o);
                    }
                },
                size(v: string) {
                    const wxh = v.split("x");
                    const w = ceil64(+wxh[0]);
                    const h = ceil64(+wxh[1]);
                    const hrUp = popOpt("hires upscale");
                    const hrSz = popOpt("hires resize");
                    let hrMethod = popOpt("hires upscaler");

                    setWidgetValue(imageNode, "width", w);
                    setWidgetValue(imageNode, "height", h);

                    if (hrUp || hrSz) {
                        let uw, uh;
                        if (hrUp) {
                            uw = w * hrUp;
                            uh = h * hrUp;
                        } else {
                            const s = hrSz.split("x");
                            uw = +s[0];
                            uh = +s[1];
                        }

                        let upscaleNode: LGraphNode;
                        let latentNode: LGraphNode;

                        if (hrMethod.startsWith("Latent")) {
                            latentNode = upscaleNode = LiteGraph.createNode("LatentUpscale");
                            graph.add(upscaleNode);
                            samplerNode.connect(0, upscaleNode, 0);

                            switch (hrMethod) {
                                case "Latent (nearest-exact)":
                                    hrMethod = "nearest-exact";
                                    break;
                            }
                            setWidgetValue(upscaleNode, "upscale_method", hrMethod, true);
                        } else {
                            const decode = LiteGraph.createNode("VAEDecodeTiled");
                            graph.add(decode);
                            samplerNode.connect(0, decode, 0);
                            vaeLoaderNode.connect(0, decode, 1);

                            const upscaleLoaderNode = LiteGraph.createNode("UpscaleModelLoader");
                            graph.add(upscaleLoaderNode);
                            setWidgetValue(upscaleLoaderNode, "model_name", hrMethod, true);

                            const modelUpscaleNode = LiteGraph.createNode("ImageUpscaleWithModel");
                            graph.add(modelUpscaleNode);
                            decode.connect(0, modelUpscaleNode, 1);
                            upscaleLoaderNode.connect(0, modelUpscaleNode, 0);

                            upscaleNode = LiteGraph.createNode("ImageScale");
                            graph.add(upscaleNode);
                            modelUpscaleNode.connect(0, upscaleNode, 0);

                            const vaeEncodeNode = (latentNode = LiteGraph.createNode("VAEEncodeTiled"));
                            graph.add(vaeEncodeNode);
                            upscaleNode.connect(0, vaeEncodeNode, 0);
                            vaeLoaderNode.connect(0, vaeEncodeNode, 1);
                        }

                        setWidgetValue(upscaleNode, "width", ceil64(uw));
                        setWidgetValue(upscaleNode, "height", ceil64(uh));

                        hrSamplerNode = LiteGraph.createNode("KSampler");
                        graph.add(hrSamplerNode);
                        ckptNode.connect(0, hrSamplerNode, 0);
                        positiveNode.connect(0, hrSamplerNode, 1);
                        negativeNode.connect(0, hrSamplerNode, 2);
                        latentNode.connect(0, hrSamplerNode, 3);
                        hrSamplerNode.connect(0, vaeNode, 0);
                    }
                },
                steps(v: number) {
                    setWidgetValue(samplerNode, "steps", +v);
                },
                seed(v: number) {
                    setWidgetValue(samplerNode, "seed", +v);
                },
            };

            for (const opt in opts) {
                if (opt in handlers) {
                    handlers[opt](popOpt(opt));
                }
            }

            if (hrSamplerNode) {
                setWidgetValue(hrSamplerNode, "steps", getWidget(samplerNode, "steps").value);
                setWidgetValue(hrSamplerNode, "cfg", getWidget(samplerNode, "cfg").value);
                setWidgetValue(hrSamplerNode, "scheduler", getWidget(samplerNode, "scheduler").value);
                setWidgetValue(hrSamplerNode, "sampler_name", getWidget(samplerNode, "sampler_name").value);
                setWidgetValue(hrSamplerNode, "denoise", +(popOpt("denoising strength") || "1"));
            }

            let n = createLoraNodes(positiveNode, positive, { node: clipSkipNode, index: 0 }, { node: ckptNode, index: 0 });
            positive = n.text;
            n = createLoraNodes(negativeNode, negative, n.prevClip, n.prevModel);
            negative = n.text;

            setWidgetValue(positiveNode, "text", replaceEmbeddings(positive));
            setWidgetValue(negativeNode, "text", replaceEmbeddings(negative));

            graph.arrange();

            for (const opt of ["model hash", "ensd"]) {
                delete opts[opt];
            }

            console.warn("Unhandled parameters:", opts);
        }
    }
}
