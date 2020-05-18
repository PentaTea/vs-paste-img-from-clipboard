import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

import PicGo from 'picgo/dist/src/core/PicGo';
import { ImgInfo, Plugin } from 'picgo/dist/src/utils/interfaces';
import getClipboardImage from 'picgo/dist/src/utils/getClipboardImage';
import { promisify } from 'util';

import { formatParam, formatString, showInfo, showError, getUploadedName } from '../utils';

const _ = require('lodash');
const _db = require('lodash-id');
import nls = require('../../package.nls.json');
_.mixin(_db);

const writeFileP = promisify(fs.writeFile);
const readFileP = promisify(fs.readFile);

export interface INotice {
  body: string;
  text: string;
  title: string;
}

export interface IUploadName {
  date: string;
  dateTime: string;
  fileName: string;
  extName: string;
  mdFileName: string;
  [key: string]: string;
}

export interface IOutputUrl {
  name: string;
  url: string;
  [key: string]: string;
}

export enum EVSPicgoHooks {
  updated = 'updated',
}

export default class VSPicgo extends EventEmitter {
  private static picgo: PicGo = new PicGo();

  constructor() {
    super();
    this.configPicgo();
    // Before upload, we change names of the images.
    this.registerRenamePlugin();
    // After upload, we use the custom output format.
    this.addGenerateOutputListener();
  }

  configPicgo() {
    const picgoConfigPath = vscode.workspace.getConfiguration('picgo').get<string>('configPath');
    if (picgoConfigPath) {
      VSPicgo.picgo.setConfig(
        JSON.parse(
          fs.readFileSync(picgoConfigPath, {
            encoding: 'utf-8',
          }),
        ),
      );
    } else {
      const picBed = vscode.workspace.getConfiguration('picgo.picBed');
      VSPicgo.picgo.setConfig({ picBed });
    }
  }

  addGenerateOutputListener() {
    VSPicgo.picgo.on('finished', async (ctx: PicGo) => {
      let urlText = '';
      const outputFormatTemplate =
        vscode.workspace.getConfiguration('picgo').get<string>('customOutputFormat') || '![${uploadedName}](${url})';
      try {
        urlText = ctx.output.reduce((acc: string, imgInfo: ImgInfo): string => {
          return `${acc}${formatString(outputFormatTemplate, {
            name: getUploadedName(imgInfo),
            url: imgInfo.imgUrl,
          })}\n`;
        }, '');
        urlText = urlText.trim();
        await this.updateData(ctx.output);
      } catch (err) {
        if (err instanceof SyntaxError) {
          showError(
            `the data file ${this.dataPath} has syntax error, ` +
              `please fix the error by yourself or delete the data file and vs-picgo will recreate for you.`,
          );
        } else {
          showError(`failed to read from data file ${this.dataPath}: ${err || ''}`);
        }
        return;
      }
      this.editor.edit(textEditor => {
        textEditor.replace(this.editor.selection, urlText);
        showInfo(`image uploaded successfully.`);
        this.emit(EVSPicgoHooks.updated, urlText);
      });
    });
  }

  registerRenamePlugin() {
    let beforeUploadPlugin: Plugin = {
      handle: (ctx: PicGo) => {
        const uploadNameTemplate =
          vscode.workspace.getConfiguration('picgo').get<string>('customUploadName') || '${fileName}';
        if (ctx.output.length === 1) {
          ctx.output[0].fileName = this.changeFilename(ctx.output[0].fileName || '', uploadNameTemplate, undefined);
        } else {
          ctx.output.forEach((imgInfo: ImgInfo, index: number) => {
            imgInfo.fileName = this.changeFilename(imgInfo.fileName || '', uploadNameTemplate, index);
          });
        }
      },
    };
    VSPicgo.picgo.helper.beforeUploadPlugins.register('vsPicgoRenamePlugin', beforeUploadPlugin);
  }

  /**
   * Returns the modified file name as per `customUploadName` setting
   * @param original The filename of the original image file.
   * @param template The template string.
   */
  changeFilename(original: string, template: string, index: number | undefined) {
    if (this.userDefineName) {
      original = this.userDefineName + (index || '') + path.extname(original);
    }
    const mdFilePath = this.editor.document.fileName;
    const mdFileName = path.basename(mdFilePath, path.extname(mdFilePath));
    let uploadNameData = formatParam(original, mdFileName);
    return formatString(template, uploadNameData);
  }

  get editor(): vscode.TextEditor {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      showError('no active markdown editor!');
    }
    return editor as vscode.TextEditor;
  }
  get dataPath(): string {
    const picgoConfig = vscode.workspace.getConfiguration('picgo');
    return picgoConfig.dataPath || path.resolve(os.homedir(), 'vs-picgo-data.json');
  }
  get userDefineName(): string {
    let selectedString = this.editor.document.getText(this.editor.selection);
    const nameReg = /[:\/\?\$]+/g; // limitations of name
    selectedString = selectedString.replace(nameReg, () => '');
    return selectedString;
  }

  async initDataFile(dataPath: string) {
    if (!fs.existsSync(dataPath)) {
      await writeFileP(dataPath, JSON.stringify({ uploaded: [] }, null, 2), 'utf8');
    }
  }

  async upload(input?: string[]): Promise<string | void | Error> {
    // This is necessary, because user may have changed settings
    this.configPicgo();

    // uploading progress
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${nls['ext.displayName']}: image uploading...`,
        cancellable: false,
      },
      progress => {
        return new Promise((resolve, reject) => {
          VSPicgo.picgo.on('uploadProgress', (p: number) => {
            progress.report({ increment: p });
            if (p === 100) {
              resolve();
            }
          });
          VSPicgo.picgo.on('notification', (notice: INotice) => {
            showError(`${notice.title}! ${notice.body || ''}${notice.text || ''}`);
            reject();
          });
        });
      },
    );

    return VSPicgo.picgo.upload(input);
  }

  async paste(target: string, editor: vscode.TextEditor): Promise<void | string | Error> {
    if (VSPicgo.picgo.configPath === '')
      return VSPicgo.picgo.log.error('The configuration file only supports JSON format.');
    // get img from clipboard
    try {
      const { imgPath, isExistFile } = await getClipboardImage(VSPicgo.picgo);
      if (imgPath === 'no image') {
        vscode.window.showInformationMessage('image not found in clipboard');
        throw new Error('image not found in clipboard');
      } else {
        this.once('failed', async () => {
          if (!isExistFile) {
            await fs.unlinkSync(imgPath);
          }
        });
        this.once('finished', async () => {
          if (!isExistFile) {
            await fs.unlinkSync(imgPath);
          }
        });

        let urlText = '';
        const outputFormatTemplate =
          vscode.workspace.getConfiguration('pasteImageFromClipboard').get<string>('customOutputFormat') ||
          '![${name}](${url})';
        try {
          let targetUrl = target + path.basename(imgPath);
          fs.renameSync(imgPath, targetUrl);

          urlText = `${formatString(outputFormatTemplate, {
            name: path.basename(imgPath),
            url: targetUrl,
          })}\n`;
          urlText = urlText.trim();
          //输出
          editor.edit(textEditor => {
            textEditor.replace(editor.selection, urlText);
            vscode.window.showInformationMessage('finished');
          });
        } catch (error) {
          vscode.window.showErrorMessage(error);
        }
      }
    } catch (e) {
      VSPicgo.picgo.log.error(e);
      VSPicgo.picgo.emit('failed', e);
      throw e;
    }
  }

  async updateData(picInfos: Array<ImgInfo>) {
    const dataPath = this.dataPath;
    if (!fs.existsSync(dataPath)) {
      await this.initDataFile(dataPath);
      showInfo('data file created at ${dataPath}.');
    }
    const dataRaw = await readFileP(dataPath, 'utf8');
    const data = JSON.parse(dataRaw);
    if (!data.uploaded) {
      data.uploaded = [];
    }
    picInfos.forEach(picInfo => {
      _.insert(data['uploaded'], picInfo);
    });
    await writeFileP(dataPath, JSON.stringify(data, null, 2), 'utf8');
  }
}
