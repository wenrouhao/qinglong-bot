import {Context} from 'telegraf';
import {uploadFile, createCronJob} from '../api/qinglong.js';
import {getErrorMessage} from './error_utils.js';
import {createSession, getSession, updateSession, deleteSession, setSessionTimeout, FileUploadSession} from './session_manager.js';
import axios from 'axios';
import {HttpsProxyAgent} from 'https-proxy-agent';

async function handleFileUpload(context: Context): Promise<void> {
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
        const supportedExtensions = ['js', 'py', 'sh', 'ts', 'mjs'];
        
        if (!fileExtension || !supportedExtensions.includes(fileExtension)) {
            await context.reply(`不支持的文件类型。支持的文件类型：${supportedExtensions.join(', ')}`);
            return;
        }

        await context.reply('正在下载文件...');

        const file = await context.telegram.getFile(document.file_id);
        console.log(`📁 [handleFileUpload] 文件信息: ${JSON.stringify(file)}`);
        
        const botToken = process.env.TG_BOT_TOKEN as string;
        const tgApiRoot = process.env.TG_API_ROOT as string || "https://api.telegram.org";
        const fileUrl = `${tgApiRoot}/file/bot${botToken}/${file.file_path}`;
        console.log(`📥 [handleFileUpload] 文件下载URL: ${fileUrl}`);
        
        let agent: HttpsProxyAgent<string> | undefined = undefined;
        const proxyUrl = process.env.TG_PROXY || '';
        if (proxyUrl) {
            agent = new HttpsProxyAgent(proxyUrl);
            console.log(`🔗 [handleFileUpload] 使用代理: ${proxyUrl}`);
        }
        
        const response = await axios.get(fileUrl, {
            httpsAgent: agent,
            responseType: 'text'
        });
        
        const fileContent = response.data;
        console.log(`✅ [handleFileUpload] 文件下载成功，内容长度: ${fileContent.length}`);

        const userId = context.from?.id;
        if (!userId) {
            await context.reply('无法获取用户ID');
            return;
        }

        createSession(userId, fileName, fileContent);

        const keyboard = {
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

        await context.reply(
            `✅ 文件下载成功！\n\n文件名：${fileName}\n\n请选择下一步操作：`,
            {reply_markup: keyboard}
        );
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(errorMessage);
        await context.reply(`❌ 文件下载失败：${errorMessage}`);
    }
}

async function handleCallbackQuery(context: Context): Promise<void> {
    console.log('📥 [handleCallbackQuery] 开始处理回调查询');
    
    try {
        const callbackQuery = context.callbackQuery;
        if (!callbackQuery || !('data' in callbackQuery)) {
            console.log('❌ [handleCallbackQuery] 回调查询无效');
            return;
        }

        const data = callbackQuery.data;
        if (!data) {
            console.log('❌ [handleCallbackQuery] 回调数据为空');
            return;
        }
        console.log(`📋 [handleCallbackQuery] 回调数据: ${data.substring(0, 50)}${data.length > 50 ? '...' : ''}`);

        const userId = context.from?.id;
        if (!userId) {
            console.log('❌ [handleCallbackQuery] 无法获取用户ID');
            await context.answerCbQuery('无法获取用户ID');
            return;
        }
        console.log(`👤 [handleCallbackQuery] 用户ID: ${userId}`);

        const session = getSession(userId);
        if (!session) {
            console.log(`❌ [handleCallbackQuery] 用户 ${userId} 没有活动会话`);
            await context.answerCbQuery('会话已过期，请重新上传文件');
            await context.reply('会话已过期，请重新上传文件');
            return;
        }
        console.log(`✅ [handleCallbackQuery] 会话存在，当前阶段: ${session.stage}`);

        if (data.startsWith('create_task_')) {
            console.log('🔍 [handleCallbackQuery] 处理创建任务');
            await handleCreateTask(context, session);
        } else if (data.startsWith('upload_only_')) {
            console.log('🔍 [handleCallbackQuery] 处理仅上传');
            await handleUploadOnly(context, session);
        } else if (data.startsWith('end_session_')) {
            console.log('🔍 [handleCallbackQuery] 处理结束会话');
            await handleEndSession(context);
        } else if (data === 'modify_params_yes') {
            console.log('🔍 [handleCallbackQuery] 处理修改参数（是）');
            await handleModifyParamsYes(context, session);
        } else if (data === 'modify_params_no') {
            console.log('🔍 [handleCallbackQuery] 处理修改参数（否）');
            await handleModifyParamsNo(context, session);
        } else if (data === 'confirm_params') {
            console.log('🔍 [handleCallbackQuery] 处理确认参数');
            await handleConfirmParams(context, session);
        } else if (data === 'edit_params') {
            console.log('🔍 [handleCallbackQuery] 处理修改参数');
            await handleEditParams(context, session);
        } else if (data === 'cancel_create') {
            console.log('🔍 [handleCallbackQuery] 处理取消创建');
            await handleCancelCreate(context);
        } else {
            console.log(`❌ [handleCallbackQuery] 未知的回调数据类型: ${data.substring(0, 30)}`);
        }

        await context.answerCbQuery();
        console.log('✅ [handleCallbackQuery] 回调查询处理完成');
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleCallbackQuery] 处理回调查询时发生错误: ${errorMessage}`);
        console.error(`📋 [handleCallbackQuery] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        await context.answerCbQuery(`操作失败：${errorMessage}`);
    }
}

async function handleCreateTask(context: Context, session: FileUploadSession): Promise<void> {
    updateSession(context.from!.id!, {stage: 'create_task'});

    const paramsJson = JSON.stringify(session.defaultParams, null, 2);
    const escapedJson = escapeHtml(paramsJson);
    
    const keyboard = {
        inline_keyboard: [
            [
                {text: '✅ 是，我要修改', callback_data: 'modify_params_yes'},
                {text: '❌ 否，使用默认', callback_data: 'modify_params_no'}
            ]
        ]
    };

    await context.reply(
        `是否修改默认参数？\n\n默认参数如下：\n\n<pre><code>${escapedJson}</code></pre>`,
        {reply_markup: keyboard, parse_mode: 'HTML'}
    );
}

async function handleUploadOnly(context: Context, session: FileUploadSession): Promise<void> {
    try {
        await context.reply('正在上传脚本到青龙面板...');
        
        await uploadFile(session.fileName, session.fileContent);
        
        deleteSession(context.from!.id!);
        await context.reply(`✅ 脚本上传成功！\n\n文件名：${session.fileName}`);
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        await context.reply(`❌ 脚本上传失败：${errorMessage}`);
    }
}

async function handleEndSession(context: Context): Promise<void> {
    deleteSession(context.from!.id!);
    await context.reply('会话已结束。');
}

async function handleModifyParamsYes(context: Context, session: FileUploadSession): Promise<void> {
    console.log('🔧 [handleModifyParamsYes] 开始处理参数修改（是）');
    
    updateSession(context.from!.id!, {stage: 'modify_params'});

    const paramsJson = JSON.stringify(session.defaultParams, null, 2);
    const escapedJson = escapeHtml(paramsJson);
    
    console.log(`📋 [handleModifyParamsYes] 默认参数: ${paramsJson}`);
    
    await context.reply(
        `请复制以下参数模板，修改后发送给我：\n\n<pre><code>${escapedJson}</code></pre>\n\n` +
        `提示：\n` +
        `• 复制上面的JSON模板\n` +
        `• 修改需要的参数\n` +
        `• 直接发送修改后的JSON给我\n\n` +
        `参数说明：\n` +
        `• name: 任务名称\n` +
        `• command: 执行命令（如：task demo.py）\n` +
        `• schedule: cron表达式（如：0 0 * * * 表示每天0点执行）\n\n` +
        `⏱️ 请在120秒内完成参数修改并发送`,
        {parse_mode: 'HTML'}
    );

    console.log(`⏱️ [handleModifyParamsYes] 设置120秒超时`);
    setSessionTimeout(context.from!.id!, 120000, async () => {
        console.log(`⏰ [handleModifyParamsYes] 参数修改超时 - 用户ID: ${context.from!.id}`);
        try {
            await context.reply('⏰ 参数修改超时，会话已结束。请重新上传文件。');
        } catch (error) {
            console.error('发送超时消息失败:', error);
        }
    });
    
    console.log('✅ [handleModifyParamsYes] 参数修改（是）处理完成');
}

async function handleModifyParamsNo(context: Context, session: FileUploadSession): Promise<void> {
    try {
        if (!session.defaultParams) {
            await context.reply('❌ 默认参数不存在');
            return;
        }

        await context.reply('正在上传脚本到青龙面板...');
        await uploadFile(session.fileName, session.fileContent);
        
        await context.reply('正在创建定时任务...');
        await createCronJob(
            session.defaultParams.name,
            session.defaultParams.command,
            session.defaultParams.schedule
        );

        deleteSession(context.from!.id!);

        await context.reply(
            `✅ 定时任务创建成功！\n\n` +
            `任务名称：${session.defaultParams.name}\n` +
            `执行命令：${session.defaultParams.command}\n` +
            `执行时间：${session.defaultParams.schedule}`
        );
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        await context.reply(`❌ 操作失败：${errorMessage}`);
    }
}

async function handleConfirmParams(context: Context, session: FileUploadSession): Promise<void> {
    console.log('🔧 [handleConfirmParams] 开始处理确认参数');
    try {
        if (!session.modifiedParams) {
            console.log('❌ [handleConfirmParams] 修改后的参数不存在');
            await context.reply('❌ 修改后的参数不存在，请重新操作');
            return;
        }
        console.log(`✅ [handleConfirmParams] 获取到修改后的参数: ${JSON.stringify(session.modifiedParams)}`);

        const params = session.modifiedParams;

        if (!params.name || !params.command || !params.schedule) {
            console.log(`❌ [handleConfirmParams] 参数验证失败 - name: ${params.name}, command: ${params.command}, schedule: ${params.schedule}`);
            await context.reply('❌ 参数格式错误，必须包含 name、command 和 schedule 字段');
            return;
        }
        console.log(`✅ [handleConfirmParams] 参数验证通过`);

        await context.reply('正在上传脚本到青龙面板...');
        await uploadFile(session.fileName, session.fileContent);
        console.log('✅ [handleConfirmParams] 文件上传成功');
        
        await context.reply('正在创建定时任务...');
        await createCronJob(params.name, params.command, params.schedule);
        console.log('✅ [handleConfirmParams] 定时任务创建成功');

        deleteSession(context.from!.id!);

        await context.reply(
            `✅ 定时任务创建成功！\n\n` +
            `任务名称：${params.name}\n` +
            `执行命令：${params.command}\n` +
            `执行时间：${params.schedule}`
        );
        console.log('✅ [handleConfirmParams] 确认参数处理完成');
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleConfirmParams] 处理确认参数时发生错误: ${errorMessage}`);
        console.error(`📋 [handleConfirmParams] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        await context.reply(`❌ 操作失败：${errorMessage}`);
    }
}

async function handleEditParams(context: Context, session: FileUploadSession): Promise<void> {
    console.log('🔧 [handleEditParams] 开始处理修改参数');
    try {
        if (!session.modifiedParams) {
            console.log('❌ [handleEditParams] 修改后的参数不存在');
            await context.reply('❌ 修改后的参数不存在，请重新操作');
            return;
        }
        console.log(`✅ [handleEditParams] 获取到当前参数: ${JSON.stringify(session.modifiedParams)}`);

        updateSession(context.from!.id!, {
            stage: 'modify_params'
        });

        const paramsJson = JSON.stringify(session.modifiedParams, null, 2);
        const escapedJson = escapeHtml(paramsJson);

        await context.reply(
            `请修改以下参数并重新发送：\n\n<pre><code>${escapedJson}</code></pre>\n\n` +
            `💡 提示：直接复制上面的JSON，修改后发送即可`,
            {parse_mode: 'HTML'}
        );
        console.log('✅ [handleEditParams] 修改参数处理完成');
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleEditParams] 处理修改参数时发生错误: ${errorMessage}`);
        console.error(`📋 [handleEditParams] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        await context.reply(`❌ 操作失败：${errorMessage}`);
    }
}

async function handleCancelCreate(context: Context): Promise<void> {
    console.log('🔧 [handleCancelCreate] 开始处理取消创建');
    try {
        const userId = context.from!.id!;
        console.log(`👤 [handleCancelCreate] 用户ID: ${userId}`);

        deleteSession(userId);
        console.log(`✅ [handleCancelCreate] 会话已删除 - 用户ID: ${userId}`);

        await context.reply('❌ 已取消创建任务，会话已结束。');
        console.log('✅ [handleCancelCreate] 取消创建处理完成');
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error(`❌ [handleCancelCreate] 处理取消创建时发生错误: ${errorMessage}`);
        console.error(`📋 [handleCancelCreate] 错误堆栈: ${error instanceof Error ? error.stack : String(error)}`);
        await context.reply(`❌ 操作失败：${errorMessage}`);
    }
}

async function handleJsonParams(context: Context): Promise<boolean> {
    console.log('📥 [handleJsonParams] 开始处理JSON参数');
    
    try {
        const userId = context.from?.id;
        if (!userId) {
            console.log('❌ [handleJsonParams] 无法获取用户ID');
            return false;
        }
        console.log(`✅ [handleJsonParams] 用户ID: ${userId}`);

        const session = getSession(userId);
        if (!session) {
            console.log(`❌ [handleJsonParams] 用户 ${userId} 没有活动会话`);
            return false;
        }
        console.log(`✅ [handleJsonParams] 会话存在，当前阶段: ${session.stage}`);

        if (session.stage !== 'modify_params') {
            console.log(`❌ [handleJsonParams] 会话阶段不匹配，期望 'modify_params'，实际 '${session.stage}'`);
            return false;
        }
        console.log(`✅ [handleJsonParams] 会话阶段验证通过`);

        const text = context.text;
        if (!text) {
            console.log('❌ [handleJsonParams] 消息文本为空');
            return false;
        }
        console.log(`📝 [handleJsonParams] 接收到的文本内容: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

        const trimmedText = text.trim();
        if (!trimmedText.startsWith('{') || !trimmedText.endsWith('}')) {
            console.log(`❌ [handleJsonParams] 文本不是JSON格式，以'${trimmedText.substring(0, 1)}'开头，以'${trimmedText.substring(trimmedText.length - 1)}'结尾`);
            return false;
        }
        console.log(`✅ [handleJsonParams] JSON格式验证通过`);

        const params = JSON.parse(trimmedText);
        console.log(`✅ [handleJsonParams] JSON解析成功: ${JSON.stringify(params)}`);

        if (!params.name || !params.command || !params.schedule) {
            console.log(`❌ [handleJsonParams] 参数验证失败 - name: ${params.name}, command: ${params.command}, schedule: ${params.schedule}`);
            await context.reply('❌ 参数格式错误，必须包含 name、command 和 schedule 字段');
            return true;
        }
        console.log(`✅ [handleJsonParams] 参数验证通过 - name: ${params.name}, command: ${params.command}, schedule: ${params.schedule}`);

        updateSession(userId, {
            modifiedParams: params,
            stage: 'confirm_params'
        });

        const keyboard = {
            inline_keyboard: [
                [
                    {text: '✅ 确认创建', callback_data: 'confirm_params'},
                    {text: '✏️ 修改参数', callback_data: 'edit_params'}
                ],
                [
                    {text: '❌ 取消', callback_data: 'cancel_create'}
                ]
            ]
        };

        const paramsJson = JSON.stringify(params, null, 2);
        const escapedJson = escapeHtml(paramsJson);
        console.log(`📤 [handleJsonParams] 准备发送确认消息`);
        
        await context.reply(
            `确认使用以下参数创建定时任务？\n\n<pre><code>${escapedJson}</code></pre>`,
            {reply_markup: keyboard, parse_mode: 'HTML'}
        );
        console.log(`✅ [handleJsonParams] 确认消息发送成功`);
        
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
