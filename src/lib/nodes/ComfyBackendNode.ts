import LGraphCanvas from "@litegraph-ts/core/src/LGraphCanvas";
import ComfyGraphNode from "./ComfyGraphNode";
import ComfyWidgets from "$lib/widgets"
import type { ComfyWidgetNode, ComfyExecutionResult } from "./ComfyWidgetNodes";
import { BuiltInSlotShape, BuiltInSlotType, type SerializedLGraphNode } from "@litegraph-ts/core";
import type IComfyInputSlot from "$lib/IComfyInputSlot";
import type { ComfyInputConfig } from "$lib/IComfyInputSlot";

/*
 * Base class for any node wit  configuration sent by the backend.
 */
export class ComfyBackendNode extends ComfyGraphNode {
    comfyClass: string;
    displayName: string | null;

    constructor(title: string, comfyClass: string, nodeData: any) {
        super(title)
        this.type = comfyClass; // XXX: workaround dependency in LGraphNode.addInput()
        this.displayName = nodeData.display_name;
        this.comfyClass = comfyClass;
        this.isBackendNode = true;

        const color = LGraphCanvas.node_colors["yellow"];
        this.color = color.color
        this.bgColor = color.bgColor

        this.setup(nodeData)

        // ComfyUI has no obvious way to identify if a node will return outputs back to the frontend based on its properties.
        // It just returns a hash like { "ui": { "images": results } } internally.
        // So this will need to be hardcoded for now.
        if (["PreviewImage", "SaveImage"].indexOf(comfyClass) !== -1) {
            this.addOutput("onExecuted", BuiltInSlotType.EVENT, { color_off: "rebeccapurple", color_on: "rebeccapurple" });
        }
    }

    // comfy class -> input name -> input config
    private static defaultInputConfigs: Record<string, Record<string, ComfyInputConfig>> = {}

    private setup(nodeData: any) {
        var inputs = nodeData["input"]["required"];
        if (nodeData["input"]["optional"] != undefined) {
            inputs = Object.assign({}, nodeData["input"]["required"], nodeData["input"]["optional"])
        }

        ComfyBackendNode.defaultInputConfigs[this.type] = {}

        for (const inputName in inputs) {
            const config: Partial<IComfyInputSlot> = {};

            const inputData = inputs[inputName];
            const type = inputData[0];

            if (inputData[1]?.forceInput) {
                this.addInput(inputName, type);
            } else {
                if (Array.isArray(type)) {
                    // Enums
                    Object.assign(config, ComfyWidgets.COMBO(this, inputName, inputData) || {});
                } else if (`${type}:${inputName}` in ComfyWidgets) {
                    // Support custom ComfyWidgets by Type:Name
                    Object.assign(config, ComfyWidgets[`${type}:${inputName}`](this, inputName, inputData) || {});
                } else if (type in ComfyWidgets) {
                    // Standard type ComfyWidgets
                    Object.assign(config, ComfyWidgets[type](this, inputName, inputData) || {});
                } else {
                    // Node connection inputs (backend)
                    this.addInput(inputName, type);
                }
            }

            if ("widgetNodeType" in config)
                ComfyBackendNode.defaultInputConfigs[this.type][inputName] = (config as IComfyInputSlot).config
        }

        for (const o in nodeData["output"]) {
            const output = nodeData["output"][o];
            const outputName = nodeData["output_name"][o] || output;
            const outputShape = nodeData["output_is_list"][o] ? BuiltInSlotShape.GRID_SHAPE : BuiltInSlotShape.CIRCLE_SHAPE;
            this.addOutput(outputName, output, { shape: outputShape });
        }

        this.serialize_widgets = false;
        // app.#invokeExtensionsAsync("nodeCreated", this);
    }

    override onSerialize(o: SerializedLGraphNode) {
        super.onSerialize(o);
        for (const input of o.inputs) {
            // strip user-identifying data, it will be reinstantiated later
            if ((input as any).config != null) {
                (input as any).config = {};
            }
        }
    }

    override onConfigure(o: SerializedLGraphNode) {
        super.onConfigure(o);

        const configs = ComfyBackendNode.defaultInputConfigs[o.type]
        for (let index = 0; index < this.inputs.length; index++) {
            const input = this.inputs[index] as IComfyInputSlot
            const config = configs[input.name]
            if (config != null && index >= 0 && index < this.inputs.length) {
                if (input.config == null || Object.keys(input.config).length !== Object.keys(config).length) {
                    console.debug("[ComfyBackendNode] restore input config", input, config)
                    input.config = config
                }
            }
            else {
                console.debug("[ComfyBackendNode] Missing input config in onConfigure()", input, configs)
                input.config = {}
            }
        }
    }

    override onExecuted(outputData: ComfyExecutionResult) {
        console.warn("onExecuted outputs", outputData)
        this.triggerSlot(0, outputData)
    }
}
