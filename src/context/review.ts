import { AbstractParser, PRFile, PatchInfo } from "../constants";
import * as diff from 'diff';
import { JavascriptParser } from "./language/javascript-parser";
import { Node } from "@babel/traverse";


const EXTENSIONS_TO_PARSERS: Map<string, AbstractParser> = new Map([
    ['ts', new JavascriptParser()],
    ['tsx', new JavascriptParser()],
    ['js', new JavascriptParser()],
    ['jsx', new JavascriptParser()]
]);

const getParserForExtension = (filename: string) => {
    const fileExtension = filename.split('.').pop().toLowerCase();
    return EXTENSIONS_TO_PARSERS.get(fileExtension) || null;
}

const expandHunk = (contents: string, hunk: diff.Hunk, linesAbove: number = 5, linesBelow: number = 5) => {
    const fileLines = contents.split("\n");
    const curExpansion: string[] = [];
    const start = Math.max(0, hunk.oldStart - 1 - linesAbove);
    const end = Math.min(fileLines.length, hunk.oldStart - 1 + hunk.oldLines + linesBelow);

    for (let i = start; i < hunk.oldStart - 1; i++) {
        curExpansion.push(fileLines[i]);
    }

    curExpansion.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    hunk.lines.forEach(line => {
        if (!curExpansion.includes(line)) {
            curExpansion.push(line);
        }
        });

    for (let i = hunk.oldStart - 1 + hunk.oldLines; i < end; i++) {
        curExpansion.push(fileLines[i]);
    }
    return curExpansion.join("\n");
}

const expandFileLines = (file: PRFile, linesAbove: number = 5, linesBelow: number = 5) => {
    const fileLines = file.old_contents.split("\n");
    const patches: PatchInfo[] = diff.parsePatch(file.patch);
    const expandedLines: string[][] = [];
    patches.forEach(patch => {
      patch.hunks.forEach(hunk => {
        const curExpansion: string[] = [];
        const start = Math.max(0, hunk.oldStart - 1 - linesAbove);
        const end = Math.min(fileLines.length, hunk.oldStart - 1 + hunk.oldLines + linesBelow);
  
        for (let i = start; i < hunk.oldStart - 1; i++) {
            curExpansion.push(fileLines[i]);
        }
  
        curExpansion.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        hunk.lines.forEach(line => {
            if (!curExpansion.includes(line)) {
              curExpansion.push(line);
            }
          });
  
        for (let i = hunk.oldStart - 1 + hunk.oldLines; i < end; i++) {
            curExpansion.push(fileLines[i]);
        }
        expandedLines.push(curExpansion);
      });
    });
  
    return expandedLines;
};
  

export const expandedPatchStrategy = (file: PRFile) => {
    const expandedPatches = expandFileLines(file);
    const expansions = expandedPatches.map((patchLines) => patchLines.join("\n")).join("\n\n")
    return `## ${file.filename}\n\n${expansions}`;
}
  
export const rawPatchStrategy = (file: PRFile) => {
    return `## ${file.filename}\n\n${file.patch}`;
}

const numberLines = (lines: string[], startLine: number) => {
    const numbered = lines.map((line, idx) => {
        return {lineNumber: startLine + idx, line: line}
    })
    return numbered;
}

const trimHunk = (hunk: diff.Hunk): diff.Hunk => {
    const startIdx = hunk.lines.findIndex((line) => line.startsWith("+") || line.startsWith("-"));
    const endIdx = hunk.lines.slice().reverse().findIndex((line) => line.startsWith("+") || line.startsWith("-"));
    const editLines = hunk.lines.slice(startIdx, hunk.lines.length - endIdx);
    return {...hunk, lines: editLines, newStart: startIdx + hunk.newStart};
}

const getSkipLines = (hunk: diff.Hunk, patchLines: string[]) => {
    const linesToSkip: number[] = [];
    const start = hunk.newStart - 1;
    let ln = 0;
    patchLines.forEach((line) => {
        if (!line.startsWith("-")) {
            linesToSkip.push(start + ln);
            ln += 1
        }
    });
    return linesToSkip;
}

const buildingScopeString = (currentFile: string, scope: Node, hunk: diff.Hunk) => {
    console.log("BUILDING SCOPE STRING");
    const res: string[] = [];
    const trimmedHunk = trimHunk(hunk);
    console.log(trimmedHunk);
    const functionStartLine = scope.loc.start.line;
    const functionEndLine = scope.loc.end.line;
    const updatedFileLines = currentFile.split('\n');
    // Extract the lines of the function
    const functionContext = updatedFileLines.slice(functionStartLine - 1, functionEndLine);
    console.log(functionContext);
    // Calculate the index where the changes should be injected into the function
    const injectionIdx = (hunk.newStart - functionStartLine) + hunk.lines.findIndex((line) => line.startsWith("+") || line.startsWith("-"));
    // Count the number of lines that should be dropped from the function
    const dropCount = trimmedHunk.lines.filter(line => !line.startsWith("-")).length;


    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    console.log(injectionIdx);
    console.log(dropCount)
    // Inject the changes into the function, dropping the necessary lines
    functionContext.splice(injectionIdx, dropCount, ...trimmedHunk.lines);

    res.push(functionContext.join("\n"));
    res.unshift(hunkHeader);
    return res;
}

const functionalContextPerHunk = (currentFile: string, hunk: diff.Hunk, parser: AbstractParser) => {
    const trimmedHunk = trimHunk(hunk);
    const res: string[] = [];
    // Count the number of insertions in the hunk
    const insertions = trimmedHunk.lines.filter((line) => !line.startsWith("-")).length;
    // Calculate the start and end lines of the changes in the hunk
    const lineStart = trimmedHunk.newStart;
    const lineEnd = lineStart + insertions;
    const largestEnclosingContext: any = parser.findEnclosingContext(currentFile, lineStart, lineEnd).enclosingContext;
    if (largestEnclosingContext) {
        const functionStartLine = largestEnclosingContext.loc.start.line;
        const functionEndLine = largestEnclosingContext.loc.end.line;
        const updatedFileLines = currentFile.split('\n');
        // Extract the lines of the function
        const functionContext = updatedFileLines.slice(functionStartLine - 1, functionEndLine);

        // Calculate the index where the changes should be injected into the function
        const injectionIdx = (hunk.newStart - functionStartLine) + hunk.lines.findIndex((line) => line.startsWith("+") || line.startsWith("-"));
        // Count the number of lines that should be dropped from the function
        const dropCount = trimmedHunk.lines.filter(line => !line.startsWith("-")).length;


        const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        // Inject the changes into the function, dropping the necessary lines
        functionContext.splice(injectionIdx, dropCount, ...trimmedHunk.lines);

        res.push(functionContext.join("\n"));
        res.unshift(hunkHeader);
        return res;
    } else {
        // If no enclosing function was found, throw an error
        throw new Error("An enclosing function could not be found.");
    }
}

const functionalContextPerHunkBackup = (currentFile: string, hunk: diff.Hunk, parser: AbstractParser) => {
    const trimmedHunk = trimHunk(hunk);
    const res: string[] = [];
    const insertions = hunk.lines.filter((line) => line.startsWith("+")).length;
    const lineStart = trimmedHunk.newStart;
    const lineEnd = lineStart + insertions;
    const largestEnclosingFunction: any = parser.findEnclosingContext(currentFile, lineStart, lineEnd).enclosingContext;
    if (largestEnclosingFunction) {
        const functionStartLine = largestEnclosingFunction.loc.start.line;
        const functionEndLine = largestEnclosingFunction.loc.end.line;
        const updatedFileLines = currentFile.split('\n');
        const functionContext = updatedFileLines.slice(functionStartLine - 1, functionEndLine);
        const injectionIdx = trimmedHunk.newStart - 1;
        const numberedFunctionLines = numberLines(functionContext, functionStartLine - 1);

        // exp
        // exp

        const editLines = trimmedHunk.lines;
        const holder: string[] = [];
        const skipLines = getSkipLines(trimmedHunk, editLines);
        const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        holder.push(hunkHeader);
        numberedFunctionLines.forEach((numberedLine) => {
            if (numberedLine.lineNumber == injectionIdx) {
                holder.push(...editLines);
            }
            if (!skipLines.includes(numberedLine.lineNumber)) {
                holder.push(numberedLine.line);
            }
        });
        const injected = holder.join("\n");
        res.push(injected);
        return res;
    } else {
        throw new Error("An enclosing function could not be found.");
    }
}

/*
suspicion:
hunk header coming out of this fn is messed up.
Need to determine what it should be and confirm that it is or isn't correct

*/
const combineHunks = (file: string, overlappingHunks: diff.Hunk[]): diff.Hunk => {
    if (!overlappingHunks || overlappingHunks.length === 0) {
        return null;
    }
    const sortedHunks = overlappingHunks.sort((a, b) => a.newStart - b.newStart);
    const fileLines = file.split('\n');
    let lastHunkEnd = sortedHunks[0].newStart + sortedHunks[0].newLines;

    const combinedHunk: diff.Hunk = {
        oldStart: sortedHunks[0].oldStart,
        oldLines: sortedHunks[0].oldLines,
        newStart: sortedHunks[0].newStart,
        newLines: sortedHunks[0].newLines,
        lines: [...sortedHunks[0].lines],
        linedelimiters: [...sortedHunks[0].linedelimiters]
    };

    for (let i = 1; i < sortedHunks.length; i++) {
        const hunk = sortedHunks[i];

        // If there's a gap between the last hunk and this one, add the lines in between
        if (hunk.newStart > lastHunkEnd) {
            combinedHunk.lines.push(...fileLines.slice(lastHunkEnd, hunk.newStart));
            combinedHunk.newLines += hunk.newStart - lastHunkEnd;
        }

        combinedHunk.oldLines += hunk.oldLines;
        combinedHunk.newLines += hunk.newLines;
        combinedHunk.lines.push(...hunk.lines);
        combinedHunk.linedelimiters.push(...hunk.linedelimiters);

        lastHunkEnd = hunk.newStart + hunk.newLines;
    }
    console.log("COMBINED");
    console.log(combinedHunk);
    return combinedHunk;
}

const diffContextPerHunk = (file: PRFile, parser: AbstractParser) => {
    const updatedFile = diff.applyPatch(file.old_contents, file.patch);
    const patches = diff.parsePatch(file.patch);
    if (!updatedFile || typeof updatedFile !== 'string') {
        // console.log("APPLYING PATCH ERROR - FALLINGBACK");
        // return fallback
        throw "THIS SHOULD NOT HAPPEN!"
    }
    if (typeof updatedFile !== 'string') {
        throw "Not string;"
    }

    /*
    option 1
    patch => hunk[] => fn context[]
     - hunk fails to get fn context -> hukn goes into basic strategy list - done
    fn context[] => Map<fn context, hunks[]> - done
    combineOverlappingHunks(scope: FnContext: hunk[]) => hunk - pending
    annotateContext(scope: FnContext, hunk: hunk) - pending
    */

    const hunks: diff.Hunk[] = [];
    const order: number[] = [];
    const scopeRangeHunkMap = new Map<string, diff.Hunk[]>();
    const scopeRangeNodeMap = new Map<string, any>();
    const expandStrategy: diff.Hunk[] = [];
    
    patches.forEach((p) => {
        p.hunks.forEach((hunk) => {
            hunks.push(hunk);
        })
    });

    hunks.forEach((hunk, idx) => {
        try {
            const trimmedHunk = trimHunk(hunk);
            const insertions = hunk.lines.filter((line) => line.startsWith("+")).length;
            const lineStart = trimmedHunk.newStart;
            const lineEnd = lineStart + insertions;
            const largestEnclosingFunction = parser.findEnclosingContext(updatedFile, lineStart, lineEnd).enclosingContext;

            if (largestEnclosingFunction) {
                const enclosingRangeKey = `${largestEnclosingFunction.loc.start.line} -> ${largestEnclosingFunction.loc.end.line}`
                let existingHunks = scopeRangeHunkMap.get(enclosingRangeKey) || [];
                existingHunks.push(hunk);
                scopeRangeHunkMap.set(enclosingRangeKey, existingHunks);
                scopeRangeNodeMap.set(enclosingRangeKey, largestEnclosingFunction);
            }
            order.push(idx);
        } catch (exc) {
            expandStrategy.push(hunk);
            order.push(idx);
        }
    });

    const scopeStategy: any[] = [];
    for (const [range, hunks] of scopeRangeHunkMap.entries()) {
        const combinedHunk = combineHunks(updatedFile, hunks);
        scopeStategy.push([range, combinedHunk]);
    }

    const contexts: string[] = [];
    scopeStategy.forEach(([rangeKey, hunk]) => {
        const context = buildingScopeString(updatedFile, scopeRangeNodeMap.get(rangeKey), hunk).join("\n")
        console.log(context)
        console.log("BUILT")
        contexts.push(context);
    })
    expandStrategy.forEach((hunk) => {
        const context = expandHunk(file.old_contents, hunk);
        contexts.push(context);
    })
    return contexts;


    const contextPerHunk: string[] = [];
    hunks.forEach(hunk => {
        let context: string = null;
        try {
            // should only for ts, tsx, js, jsx files rn
            context = functionalContextPerHunk(updatedFile as string, hunk, parser).join("\n`")
            console.log("!!!!!!!!!! WORKED !!!!!!!!!!!!!!")
            console.log(context);
        } catch (exc) {
            // console.log(exc);
            console.log("!!!!!!!! FALLING BACK !!!!!!!!!")
            context = expandHunk(file.old_contents, hunk);
        }
        contextPerHunk.push(context);
    })
    return contextPerHunk;
}

const functionContextPatchStrategy = (file: PRFile, parser: AbstractParser): string => {
    // console.log("USING DIFF FUNCTION CONTEXT STRATEGY");
    const contextChunks = diffContextPerHunk(file, parser);
    let res = null;
    try {
        res = `## ${file.filename}\n\n${contextChunks.join("\n\n")}`;
    } catch (exc) {
        res = expandedPatchStrategy(file);
    }
    console.log("!!!!!!@@@@@@@!!!!!!");
    console.log(res);
    return res;
}

export const smarterContextPatchStrategy = (file: PRFile) => {
    const parser: AbstractParser = getParserForExtension(file.filename);
    if (parser != null) {
        return functionContextPatchStrategy(file, parser);
    } else {
        return expandedPatchStrategy(file);
    }
}