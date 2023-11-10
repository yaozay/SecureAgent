import { assignLineNumbers, getParserForExtension } from "../constants";
import { chatFns } from "../llms/chat";
import { REPAIR_FNs, getRepairPrompt } from "../prompts/repair-prompt";

const overwriteFileLines = (contents: string, code: string, lineStart: number) => {
    let lines = contents.split('\n');
    const codeLines = code.split('\n').filter((line) => line.length > 0);
    lines.splice(lineStart <= 0 ? 0 : lineStart - 1, codeLines.length, ...codeLines);
    return lines;
}

const insertFileLines = (contents: string, code: string, lineStart: number) => {
    const lines = contents.split("\n");
    const codeLines = code.split("\n");
    lines.splice(lineStart <= 0 ? 0 : lineStart - 1, 0, ...codeLines);
    return lines;
}

const executeRepair = (mode: string, fileContents: string, code: string, lineStart: number) => {
    let updatedLines: string[] = [];
    if (mode == "insert") {
        updatedLines = insertFileLines(fileContents, code, lineStart);
    } else if (mode == "overwrite") {
        updatedLines = overwriteFileLines(fileContents, code, lineStart);
    } else {
        const err = `Unsupported file edit mode: ${mode}`;
        throw new Error(err);
    }
    return updatedLines.join("\n");
}

const repairChat = async (sessionId: string, fileContent: string, error: string) => {
    const fileWithLines = assignLineNumbers(fileContent);
    const convo = getRepairPrompt(fileWithLines, error);
    const resp = await chatFns("repair", sessionId, convo, REPAIR_FNs, {"function_call": {"name": "repair"}});
    const args = JSON.parse(resp.choices[0].message.function_call.arguments);
    return {
        "mode": args["mode"],
        "code": args["code"],
        "lineStart": args["lineStart"]
    };
}

export const executeEdit = async (sessionId: string, mode: string, fileName: string, fileContents: string, code: string, lineStart: number) => {
    const retryLimit = 5;
    
    let updatedContent = executeRepair(mode, fileContents, code, lineStart);
    const parser = getParserForExtension(fileName);
    if (parser == null) {
        return updatedContent;
    }
    
    let retryAttempt = 0;
    let parserResult = parser.dryRun(updatedContent);
    while (retryAttempt < retryLimit && !parserResult.valid) {
        retryAttempt += 1;
        const { mode, code, lineStart } = await repairChat(sessionId, updatedContent, parserResult.error);
        updatedContent = executeRepair(mode, updatedContent, code, lineStart);
        parserResult = parser.dryRun(updatedContent);
    }
    // throw if parser result is still invalid
    if (!parserResult.valid) {
        throw parserResult.error;
    }
    return updatedContent;
}
