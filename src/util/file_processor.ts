import {Context} from 'telegraf';
import {uploadFile, createCronJob} from '../api/qinglong.js';
import {getErrorMessage} from './error_utils.js';
import {createSession, getSession, updateSession, deleteSession, setSessionTimeout, FileUploadSession} from './session_manager.js';
import axios from 'axios';
import {HttpsProxyAgent} from 'https-proxy-agent';

interface TaskParams {
    name: string;
    command: string;
    schedule: string;
}

interface TextMessage {
    message_id: number;
}

interface InlineKeyboardMarkup {
    inline_keyboard: Array<Array<{text: string; callback_data: string}>>;
}

interface TelegramFile {
    file_path?: string;
}

async function downloadFileWithRetry(fileUrl: string, agent: HttpsProxyAgent<string> | undefined, maxRetries: number = 3): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(fileUrl, {
                httpsAgent: agent,
                responseType: 'text',
                timeout: 30000
            });
            
            return response.data;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`❌ [downloadFileWithRetry] 第 ${attempt} 次下载失败: ${getErrorMessage(lastError)}`);
            
            if (attempt < maxRetries) {
                const delayMs = attempt * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    
    throw lastError || new Error('文件下载失败');
}

async function getFileWithRetry(context: Context, fileId: string, maxRetries: number = 3): Promise<TelegramFile> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const file = await context.telegram.getFile(fileId);
            return file;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`❌ [getFileWithRetry] 第 ${attempt} 次获取文件信息失败: ${getErrorMessage(lastError)}`);
            
            if (attempt < maxRetries) {
                const delayMs = attempt * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    
    throw lastError || new Error('获取文件信息失败');
}

async function handleFileUpload(context: Context): Promise<void> {
    let loadingMessage: TextMessage | null = null;
    try {
        const message = context.message;
        if (!message || !('document' in message)) {
            await context.reply('未检测到文件');
            return;
        }

        const document = message.document;
        if (!document) {
            await context.reply('未检测到文件');
            return;
        }

        const fileName = document.file_name;
        
        if (!fileName) {
            await context.reply('无法获取文件名');
            return;
        }

        const fileExtension = fileName.split('.').pop()?.toLowerCase();
        const supportedExtensions = ['js', 'py', 'sh', 'ts', 'mjs', 'txt'];
        
        if (!fileExtension || !supportedExtensions.includes(fileExtension)) {
            await context.reply(`不支持的文件类型。支持的文件类型：${supportedExtensions.join(', ')}`);
            return;
        }

        loadingMessage = await context.reply('正在下载文件...');

        const file = await getFileWithRetry(context, document.file_id);
        
        const botToken = process.env.TG_BOT_TOKEN as string;
        const proxyUrl = process.env.TG_PROXY || '';
        
        let fileUrl: string;
        let agent: HttpsProxyAgent<string> | undefined = undefined;
        
        if (proxyUrl) {
            fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
            agent = new HttpsProxyAgent(proxyUrl);
        } else {
            const tgApiRoot = process.env.TG_API_ROOT as string || "https://api.telegram.org";
            fileUrl = `${tgApiRoot}/file/bot${botToken}/${file.file_path}`;
        }
        
        const fileContent = await downloadFileWithRetry(fileUrl, agent);

        const userId = context.from?.id;
        if (!userId) {
            await context.reply('无法获取用户ID');
            return;
        }

        createSession(userId, fileName, fileContent);

        const keyboard = createFileOperationKeyboard(fileName);

        await context.deleteMessage(loadingMessage.message_id);

        await context.reply(
            `✅ 文件下载成功！\n\n文件名：${fileName}\n\n请选择下一步操作：`,
            {reply_markup: keyboard}
        );
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleFileUpload] 文件下载失败: ${errorMessage}`);
        console.error(`📋 [handleFileUpload] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        
        if (loadingMessage) {
            try {
                await context.deleteMessage(loadingMessage.message_id);
            } catch (deleteError) {
                console.error(`❌ [handleFileUpload] 删除加载消息失败: ${getErrorMessage(deleteError)}`);
            }
        }
        
        await context.reply(`❌ 文件下载失败：${errorMessage}`);
    }
}

async function handleCallbackQuery(context: Context): Promise<void> {
    try {
        const callbackQuery = context.callbackQuery;
        if (!callbackQuery || !('data' in callbackQuery)) {
            return;
        }

        const data = callbackQuery.data;
        if (!data) {
            return;
        }

        const userId = context.from?.id;
        if (!userId) {
            await context.answerCbQuery('无法获取用户ID');
            return;
        }

        const session = getSession(userId);
        if (!session) {
            await context.answerCbQuery('会话已过期，请重新上传文件');
            await context.reply('会话已过期，请重新上传文件');
            return;
        }

        if (data.startsWith('create_task_')) {
            await handleCreateTask(context, session);
        } else if (data.startsWith('upload_only_')) {
            await handleUploadOnly(context, session);
        } else if (data.startsWith('end_session_')) {
            await handleEndSession(context);
        } else if (data === 'modify_params_yes') {
            await handleModifyParamsYes(context, session);
        } else if (data === 'modify_params_no') {
            await handleModifyParamsNo(context, session);
        } else if (data === 'back_to_create_task') {
            await handleBackToCreateTask(context, session);
        } else if (data === 'end_session') {
            await handleEndSession(context);
        }

        await context.answerCbQuery();
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleCallbackQuery] 处理回调查询时发生错误: ${errorMessage}`);
        console.error(`📋 [handleCallbackQuery] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        await context.answerCbQuery(`操作失败：${errorMessage}`);
    }
}

async function deleteCurrentMessage(context: Context): Promise<void> {
    const callbackQuery = context.callbackQuery;
    if (callbackQuery && 'message' in callbackQuery) {
        const message = callbackQuery.message;
        if (message && 'message_id' in message) {
            try {
                await context.deleteMessage(message.message_id);
            } catch (deleteError) {
                console.error(`❌ [deleteCurrentMessage] 删除消息失败: ${getErrorMessage(deleteError)}`);
            }
        }
    }
}

async function deleteMessageIfExists(context: Context, message: TextMessage | null, messageName: string): Promise<void> {
    if (!message || !message.message_id) {
        return;
    }
    
    try {
        await context.deleteMessage(message.message_id);
    } catch (deleteError) {
        console.error(`❌ [deleteMessageIfExists] 删除${messageName}失败: ${getErrorMessage(deleteError)}`);
    }
}

async function editOrReplyMessage(context: Context, text: string, keyboard: InlineKeyboardMarkup, functionName: string): Promise<void> {
    try {
        const callbackQuery = context.callbackQuery;
        if (callbackQuery && 'message' in callbackQuery) {
            const message = callbackQuery.message;
            if (message && 'message_id' in message && 'chat' in message) {
                await context.editMessageText(
                    text,
                    {reply_markup: keyboard, parse_mode: 'HTML'}
                );
            }
        }
    } catch (error) {
        console.error(`❌ [${functionName}] 编辑消息失败: ${getErrorMessage(error)}`);
        await context.reply(
            text,
            {reply_markup: keyboard, parse_mode: 'HTML'}
        );
    }
}

function createFileOperationKeyboard(fileName: string): InlineKeyboardMarkup {
    return {
        inline_keyboard: [
            [
                {text: '📋 创建任务', callback_data: `create_task_${fileName}`},
                {text: '📤 仅上传', callback_data: `upload_only_${fileName}`}
            ],
            [
                {text: '❌ 结束会话', callback_data: `end_session_${fileName}`}
            ]
        ]
    };
}

function createModifyParamsKeyboard(): InlineKeyboardMarkup {
    return {
        inline_keyboard: [
            [
                {text: '✅ 是，我要修改', callback_data: 'modify_params_yes'},
                {text: '❌ 否，使用默认', callback_data: 'modify_params_no'}
            ],
            [
                {text: '❌ 结束会话', callback_data: 'end_session'}
            ]
        ]
    };
}

function createNavigationKeyboard(): InlineKeyboardMarkup {
    return {
        inline_keyboard: [
            [
                {text: '⬆️ 返回上级', callback_data: 'back_to_create_task'},
                {text: '❌ 结束会话', callback_data: 'end_session'}
            ]
        ]
    };
}

async function createTaskWithParams(context: Context, session: FileUploadSession, params: TaskParams, functionName: string): Promise<void> {
    let uploadMessage: TextMessage | null = null;
    let createMessage: TextMessage | null = null;
    
    try {
        uploadMessage = await context.reply('正在上传脚本到青龙面板...');
        
        await uploadFile(session.fileName, session.fileContent);
        
        await deleteMessageIfExists(context, uploadMessage, '上传消息');
        
        createMessage = await context.reply('正在创建定时任务...');
        
        await createCronJob(params.name, params.command, params.schedule);
        
        await deleteMessageIfExists(context, createMessage, '创建任务消息');

        deleteSession(context.from!.id!);

        await context.reply(
            `✅ 定时任务创建成功！\n\n` +
            `任务名称：${params.name}\n` +
            `执行命令：${params.command}\n` +
            `执行时间：${params.schedule}`
        );
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [${functionName}] 创建任务时发生错误: ${errorMessage}`);
        console.error(`📋 [${functionName}] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        
        await deleteMessageIfExists(context, createMessage, '创建任务消息');
        await deleteMessageIfExists(context, uploadMessage, '上传消息');
        
        deleteSession(context.from!.id!);
        
        await context.reply(`❌ 操作失败：${errorMessage}`);
    }
}

async function showModifyParamsInterface(context: Context, session: FileUploadSession, editMode: boolean = false): Promise<void> {
    updateSession(context.from!.id!, {stage: 'create_task'});

    const paramsJson = JSON.stringify(session.defaultParams, null, 2);
    const escapedJson = escapeHtml(paramsJson);
    
    const keyboard = createModifyParamsKeyboard();

    const text = `是否修改默认参数？\n\n默认参数如下：\n\n<pre><code>${escapedJson}</code></pre>`;
    
    if (editMode) {
        await editOrReplyMessage(context, text, keyboard, 'showModifyParamsInterface');
    } else {
        await context.reply(text, {reply_markup: keyboard, parse_mode: 'HTML'});
    }
}

async function handleCreateTask(context: Context, session: FileUploadSession): Promise<void> {
    await deleteCurrentMessage(context);
    
    await showModifyParamsInterface(context, session, false);
}

async function handleUploadOnly(context: Context, session: FileUploadSession): Promise<void> {
    await deleteCurrentMessage(context);
    
    let uploadMessage: TextMessage | null = null;
    
    try {
        uploadMessage = await context.reply('正在上传脚本到青龙面板...');
        
        await uploadFile(session.fileName, session.fileContent);
        
        await deleteMessageIfExists(context, uploadMessage, '上传消息');
        
        deleteSession(context.from!.id!);
        
        await context.reply(`✅ 脚本上传成功！\n\n文件名：${session.fileName}`);
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        
        await deleteMessageIfExists(context, uploadMessage, '上传消息');
        
        deleteSession(context.from!.id!);
        
        await context.reply(`❌ 脚本上传失败：${errorMessage}`);
    }
}

async function handleEndSession(context: Context): Promise<void> {
    await deleteCurrentMessage(context);
    
    deleteSession(context.from!.id!);
    
    const warningMessage = await context.reply('⚠️已取消文件上传');
    
    setTimeout(async () => {
        try {
            await context.deleteMessage(warningMessage.message_id);
        } catch (deleteError) {
            console.error(`❌ [handleEndSession] 删除提示消息失败: ${getErrorMessage(deleteError)}`);
        }
    }, 10000);
}

async function handleModifyParamsYes(context: Context, session: FileUploadSession): Promise<void> {
    updateSession(context.from!.id!, {stage: 'modify_params'});

    const paramsJson = JSON.stringify(session.defaultParams, null, 2);
    const escapedJson = escapeHtml(paramsJson);
    
    const keyboard = createNavigationKeyboard();

    const text = 
        `请复制以下参数模板，修改后发送给我：\n\n<pre><code>${escapedJson}</code></pre>\n\n` +
        `提示：\n` +
        `• 复制上面的JSON模板\n` +
        `• 修改需要的参数\n` +
        `• 直接发送修改后的JSON给我\n\n` +
        `参数说明：\n` +
        `• name: 任务名称\n` +
        `• command: 执行命令（如：task demo.py）\n` +
        `• schedule: cron表达式（如：0 0 * * * 表示每天0点执行）\n\n` +
        `⏱️ 请在120秒内完成参数修改并发送`;
    
    await editOrReplyMessage(context, text, keyboard, 'handleModifyParamsYes');

    setSessionTimeout(context.from!.id!, 120000, async () => {
        try {
            await context.reply('⏰ 参数修改超时，会话已结束。请重新上传文件。');
        } catch (error) {
            console.error(`❌ [handleModifyParamsYes] 发送超时消息失败: ${getErrorMessage(error)}`);
        }
    });
}

async function handleModifyParamsNo(context: Context, session: FileUploadSession): Promise<void> {
    await deleteCurrentMessage(context);
    
    await createTaskWithParams(context, session, session.defaultParams!, 'handleModifyParamsNo');
}

async function handleBackToCreateTask(context: Context, session: FileUploadSession): Promise<void> {
    await showModifyParamsInterface(context, session, true);
}

async function handleJsonParams(context: Context): Promise<boolean> {
    try {
        const userId = context.from?.id;
        if (!userId) {
            return false;
        }

        const session = getSession(userId);
        if (!session) {
            return false;
        }

        if (session.stage !== 'modify_params') {
            return false;
        }

        const text = context.text;
        if (!text) {
            return false;
        }

        const trimmedText = text.trim();
        if (!trimmedText.startsWith('{') || !trimmedText.endsWith('}')) {
            return false;
        }

        const params = JSON.parse(trimmedText);

        if (!params.name || !params.command || !params.schedule) {
            await context.reply('❌ 参数格式错误，必须包含 name、command 和 schedule 字段');
            return true;
        }
        
        await createTaskWithParams(context, session, params, 'handleJsonParams');
        
        return true;
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleJsonParams] 处理JSON参数时发生错误: ${errorMessage}`);
        console.error(`📋 [handleJsonParams] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        return false;
    }
}

function escapeHtml(text: string): string {
    const htmlEntities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEntities[char]);
}

export {
    handleFileUpload,
    handleCallbackQuery,
    handleJsonParams,
};
