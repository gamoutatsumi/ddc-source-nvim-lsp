import {
  BaseSource,
  DdcGatherItems,
  Item,
} from "https://deno.land/x/ddc_vim@v3.6.0/types.ts";
import {
  assertEquals,
  autocmd,
  fn,
} from "https://deno.land/x/ddc_vim@v3.6.0/deps.ts";
import {
  GatherArguments,
  OnInitArguments,
} from "https://deno.land/x/ddc_vim@v3.6.0/base/source.ts";
import {
  CompletionItem,
  InsertTextFormat,
  Position,
} from "https://deno.land/x/vscode_languageserver_types@v0.1.0/mod.ts";

const LSP_KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

const CompletionTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  TriggerForIncompleteCompletions: 3,
};

export interface CompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}

type CompletionParams = {
  position: Position;
  context?: CompletionContext;
};

type Params = {
  kindLabels: Record<string, string>;
  enableResolveItem: boolean;
};

function getWord(
  item: CompletionItem,
  input: string,
  line: string,
  completePosition: number,
): string {
  let word = item.label.trimStart();

  if (item.textEdit) {
    const textEdit = item.textEdit;
    word = textEdit.newText;
    if ("range" in textEdit) {
      const start = textEdit.range.start;
      const end = textEdit.range.end;
      if (item.insertTextFormat == InsertTextFormat.Snippet) {
        word = getSnippetWord(word);
      }
      if (start.line == end.line && start.character == end.character) {
        word = `${input.slice(completePosition)}${word}`;
      } else {
        // remove overlapped text which comes before/after complete position
        if (
          start.character < completePosition &&
          line.slice(start.character, completePosition) ==
            word.slice(0, completePosition - start.character)
        ) {
          word = word.slice(completePosition - start.character);
        }
        const curCol = input.length;
        if (
          end.character > curCol &&
          line.slice(curCol, end.character) ==
            word.slice(curCol - end.character)
        ) {
          word = word.slice(0, curCol - end.character);
        }
      }
    }
  } else if (item.insertText) {
    word = item.insertText;
    if (item.insertTextFormat == InsertTextFormat.Snippet) {
      word = getSnippetWord(word);
    }
  }
  return word;
}

function getSnippetWord(txt: string): string {
  // remove snippet's tabstop
  txt = txt.replace(/\$[0-9]+|\${(?:\\.|[^}])+}/g, "");
  txt = txt.replace(/\\(.)/g, "$1");
  const m = txt.match(
    /^((?:<[^>]*>)|(?:\[[^\]]*\])|(?:\([^\)]*\))|(?:{[^}]*})|(?:"[^"]*")|(?:'[^']*'))/,
  );
  if (m) {
    return m[0];
  }
  const valid = txt.match(/^[^"'' (<{\[\t\r\n]+/);
  if (!valid) {
    return txt;
  }
  return valid[0];
}

export class Source extends BaseSource<Params> {
  private counter = 0;

  override async onInit(
    args: OnInitArguments<Params>,
  ): Promise<void> {
    await autocmd.group(
      args.denops,
      "ddc-nvim_lsp",
      (_: autocmd.GroupHelper) => {
      },
    );

    if (args.sourceParams.enableResolveItem) {
      await args.denops.cmd(
        "autocmd ddc-nvim_lsp User PumCompleteChanged call v:lua.require" +
          "'ddc_nvim_lsp'.resolve_item(get(pum#current_item(), 'user_data', {}))",
      );
      await args.denops.cmd(
        "autocmd ddc-nvim_lsp CompleteChanged * call v:lua.require" +
          "'ddc_nvim_lsp'.resolve_item(get(v:event.completed_item, 'user_data', {}))",
      );
    }
  }

  override async gather(
    args: GatherArguments<Params>,
  ): Promise<DdcGatherItems> {
    this.counter = (this.counter + 1) % 100;

    const params = await args.denops.call(
      "luaeval",
      "vim.lsp.util.make_position_params()",
    ) as CompletionParams;

    params.context = {
      triggerKind: args.isIncomplete
        ? CompletionTriggerKind.TriggerForIncompleteCompletions
        : CompletionTriggerKind.Invoked,
    };

    const id = `source/${this.name}/${this.counter}`;

    const [payload] = await Promise.all([
      args.onCallback(id) as Promise<{
        result: CompletionItem[];
        success: boolean;
        isIncomplete: boolean;
      }>,
      args.denops.call(
        "luaeval",
        "require('ddc_nvim_lsp').request_items(" +
          "_A.arguments, _A.id, _A.trigger)",
        { "arguments": params, id, trigger: args.context.input.slice(-1) },
      ),
    ]);

    // payload.result may be not Array
    if (payload?.result?.length == null) {
      return [];
    }

    return {
      items: this.processitems(
        args.sourceParams,
        payload.result,
        args.context.input,
        await fn.getline(args.denops, "."),
        args.completeStr.length,
        args.context.input.length - args.completeStr.length,
      ),
      isIncomplete: payload.isIncomplete,
    };
  }

  private processitems(
    params: Params,
    results: CompletionItem[],
    input: string,
    line: string,
    compareLength: number,
    completePosition: number,
  ): Item[] {
    // NOTE: Returned items may be huge.  It must be length filtered.
    const items = results.filter(
      (v) => v.label.trimStart().length >= compareLength,
    ).map((v) => {
      const item = {
        word: getWord(v, input, line, completePosition),
        abbr: v.label.trim(),
        dup: false,
        "user_data": {
          lspitem: JSON.stringify(v),
        },
        kind: "",
        menu: "",
        info: "",
      };

      if (typeof v.kind === "number") {
        const labels = params.kindLabels;
        const kind = LSP_KINDS[v.kind - 1];
        item.kind = kind in labels ? labels[kind] : kind;
      } else if (
        v.insertTextFormat && v.insertTextFormat == InsertTextFormat.Snippet
      ) {
        item.kind = "Snippet";
      }

      if (v.detail) {
        item.menu = v.detail;
      }

      if (typeof v.documentation === "string") {
        item.info = v.documentation;
      } else if (v.documentation && "value" in v.documentation) {
        item.info = v.documentation.value;
      }

      return item;
    });

    return items;
  }

  override params(): Params {
    return {
      kindLabels: {},
      enableResolveItem: false,
    };
  }
}

Deno.test("getWord", () => {
  assertEquals(
    getWord(
      {
        "label": '"Cascadia Mono"',
        "textEdit": {
          "range": {
            "end": { "character": 14, "line": 39 },
            "start": { "character": 12, "line": 39 },
          },
          "newText": '"Cascadia Mono"',
        },
        "insertText": '"Cascadia Mono"',
        "insertTextFormat": 2,
      },
      '"fontFace": "',
      '"fontFace": ""',
      13,
    ),
    "Cascadia Mono",
  );
  assertEquals(
    getWord(
      {
        "label": '"Cascadia Mono"',
        "textEdit": {
          "range": {
            "end": { "character": 14, "line": 39 },
            "start": { "character": 12, "line": 39 },
          },
          "newText": '"Cascadia Mono"',
        },
        "insertText": '"Cascadia Mono"',
        "insertTextFormat": 2,
      },
      '"fontFace": "',
      '"fontFace": "',
      13,
    ),
    'Cascadia Mono"',
  );
  assertEquals(
    getWord(
      {
        "label": " vector>",
        "textEdit": {
          "range": {
            "end": { "character": 12, "line": 1 },
            "start": { "character": 10, "line": 1 },
          },
          "newText": "vector>",
        },
        "insertText": "vector>",
        "kind": 17,
        "insertTextFormat": 2,
      },
      "#include <v",
      "#include <v>",
      10,
    ),
    "vector",
  );

  assertEquals(
    getWord(
      {
        "label": "fig:HfO2",
        "textEdit": {
          "range": {
            "end": { "character": 10, "line": 52 },
            "start": { "character": 5, "line": 52 },
          },
          "newText": "fig:HfO2",
        },
      },
      "\\ref{fig:h",
      "\\ref{fig:h}",
      9,
    ),
    "HfO2",
  );
});

Deno.test("getSnippetWord", () => {
  // test cases from nvim-cmp
  assertEquals(getSnippetWord("all: $0;"), "all:");
  assertEquals(getSnippetWord("print"), "print");
  assertEquals(getSnippetWord("$variable"), "$variable");
  assertEquals(getSnippetWord("print()"), "print");
  assertEquals(getSnippetWord('["cmp#confirm"]'), '["cmp#confirm"]');
  assertEquals(getSnippetWord('"devDependencies":'), '"devDependencies"');
  assertEquals(getSnippetWord('\\"devDependencies\\":'), '"devDependencies"');
});
