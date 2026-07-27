// ... existing code ...
import * as vscode from 'vscode';

interface Filter {
	"name": string,
	"options": string[],
}

interface DimensionOption {
	"Key": string,
	"Title": string
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "statlinebrowser" is now active!');

	let currentPanel: vscode.WebviewPanel | undefined = undefined;

	context.subscriptions.push(
		vscode.commands.registerCommand("statlinebrowser.openBrowser", async () => {
			const columnToShowIn = vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

			if (currentPanel) {
				currentPanel.reveal(columnToShowIn);
				return;
			}

			currentPanel = vscode.window.createWebviewPanel(
				"statlineBrowser",
				"CBS Statline Browser",
				columnToShowIn || vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true
				}
			);

			const nonce = getNonce();
			let mainPanelHTMLContent = await getHtmlContent(context, "mainPanel.html");
			
			// Replace placeholder with nonce in HTML
			mainPanelHTMLContent = mainPanelHTMLContent.replace(/{{nonce}}/g, nonce);
			
			currentPanel.webview.html = mainPanelHTMLContent;

			const messageHandler = currentPanel.webview.onDidReceiveMessage(async (message) => {
				const webview = currentPanel?.webview;
				if (!webview) return;

				switch(message.command) {
					case "DOMContentLoaded":
						console.log("DOM content loaded for main panel");
						const lastTableId = context.workspaceState.get<string>("lastTableId");

						if (lastTableId) {
							webview.postMessage({
								command: "setTableId",
								value: lastTableId
							});
						}

						const filters = context.workspaceState.get<any>("lastFilters");

						if (filters) {
							webview.postMessage({
								command: "renderFilters",
								filters: filters
							});
						}
						
						const savedSelectedFilters = context.workspaceState.get<Record<string, string[]>>("lastSelectedFilters");
						const savedSelectedTopics = context.workspaceState.get<string[]>("lastSelectedTopics");
						if (savedSelectedFilters || savedSelectedTopics) {
							webview.postMessage({
								command: "setSelectedFilters",
								selectedFilters: savedSelectedFilters,
								selectedTopics: savedSelectedTopics
							});
						}
						return;
					case "fetchOptions":
						if (!message.tableId) {
							console.log("Received Fetch Table without table id!");
						}
						
						await context.workspaceState.update("lastTableId", message.tableId);

						console.log(`User wants to display table with ID: ${message.tableId}`);
						console.log(`First fetching catalog data on table...`);

						const dataProperties = await getCBSTableDataProperties(message.tableId);
						const dimensions = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.Dimension");
						const geoDimensions = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.GeoDimension");
						const timeDimensions = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.TimeDimension");
						const topics = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.Topic");
						
						const allDimensions = [...timeDimensions, ...geoDimensions,...dimensions];

						const dimensionFilters: Filter[] = await Promise.all(
							allDimensions.map(async (dimension) => ({
								name: dimension.Key,
								options: await getCBSTableDimensionOptions(message.tableId, dimension.Key)
							}))
						);

						const topicFilter: Filter = {
							name: "Topics",
							options: topics.map((t: any) => `${t.Key}: ${t.Title}`)
						};

						const newFilters: Filter[] = [topicFilter, ...dimensionFilters];

						await context.workspaceState.update("lastFilters", newFilters);

						webview.postMessage({
							command: "renderFilters",
							filters: newFilters
						});
						return;
					case "fetchTable":
						console.log(`Fetching Statline table with ID ${message.tableId}`);
						const fetchedTableData = await fetchCBSTableData(message.tableId, message.selectedFilters, message.selectedTopics);
						
						const rows = fetchedTableData[0];
						const anyErrors = fetchedTableData[1];
						if (rows && rows.length > 0) {
							if (anyErrors) {
								webview.postMessage({
									command: "updateStatus",
									status: "Had to retry fetch to truncate table, view does not show all rows according to filters."
								});
							} else {
								webview.postMessage({
									command: "updateStatus",
									status: ""
								});
							}
							// Generate table headers from the keys of the first row object
							const headers = Object.keys(rows[0]);
							const headerHtml = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
							
							// Generate table rows
							const rowHtml = rows.map((row: any) => 
								`<tr>${headers.map(h => `<td>${row[h] !== undefined ? row[h] : ''}</td>`).join('')}</tr>`
							).join('');

							const tableHtml = `<table><thead>${headerHtml}</thead><tbody>${rowHtml}</tbody></table>`;

							// Send back to webview
							webview.postMessage({
								command: "renderTable",
								html: tableHtml
							});
						} else {
							webview.postMessage({
								command: "renderTable",
								html: "<p>No data returned for the selected filters.</p>"
							});

							webview.postMessage({
								command: "updateStatus",
								status: "Possibly encountered error during fetching table"
							});
						}
						return;
					case "saveSelectedFilters":
						await context.workspaceState.update("lastSelectedFilters", message.selectedFilters);
						await context.workspaceState.update("lastSelectedTopics", message.selectedTopics);
						return;
					case "fetchCatalog":
						console.log("Fetching CBS table catalog...");
						const catalogTables = await getCBSTableCatalog();
						webview.postMessage({
							command: "renderCatalog",
							tables: catalogTables
						});
						return;
				}
			});

			currentPanel.onDidDispose(
				() => {
					messageHandler.dispose();
					currentPanel = undefined;
				},
				null,
				context.subscriptions
			);
		})
	);
};

async function getCBSTableCatalog() {
    const url = "https://opendata.cbs.nl/ODataCatalog/Tables?$select=Identifier,Title,ShortDescription";
    console.log(`Constructed catalog url: ${url}`);
    try {
        const response = await fetch(url, {
            headers: {
                "Accept": "application/json"
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as any;
        if (data && data.value) {
            return data.value;
        }
        return [];
    } catch (e) {
        console.error("Failed to fetch CBS table catalog", e);
        return [];
    }
}

async function getCBSTableDataProperties(tableId: string) {
    // Note: The TableInfos endpoint uses single quotes for the ID
    const url = `https://opendata.cbs.nl/ODataApi/OData/${tableId}/DataProperties`;

	console.log(`Constructed url: ${url}`)
    
    try {
        const response = await fetch(url);

		if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

		console.log(`Response: ${response}`)
        const data = await response.json() as any;        
        if (data && data.value && data.value.length > 0) {
			const tableData = data.value;
			console.log(`Table data: ${tableData}`);
			return tableData;
		} else {
			console.warn("Table data not found or empty.");
			throw new Error("Table Info is Empty!");
		}
    } catch (e) {
        console.error("Failed to fetch table info", e);
    }
}

async function getCBSTableDimensionOptions(tableId: string, key: string): Promise<string[]> {
	const url = `https://opendata.cbs.nl/ODataApi/OData/${tableId}/${key}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as any;
        
        if (data && data.value && data.value.length > 0) {
			return data.value.map((option: DimensionOption) => `${option.Key}: ${option.Title}`);
		} else {
			console.warn("Table data not found or empty.");
			throw new Error("Table Info is Empty!");
		}
    } catch (error) {
        console.error("Failed to fetch CBS data:", error);
		return [];
    }
}

function buildODataQuery(selectedFilters: Record<string, string[]>, selectedTopics: string[], dimensionKeys: string[]): string {
    const queryParts: string[] = [];

    // Handle $select for topics, ensuring dimension keys are always included
    if (selectedTopics && selectedTopics.length > 0) {
        const selectFields = [...dimensionKeys, ...selectedTopics];
        queryParts.push(`$select=${selectFields.join(",")}`);
    }

    const filterClauses: string[] = [];

    for (const [dimensionKey, values] of Object.entries(selectedFilters)) {
        if (values && values.length > 0) {
            // Create an 'or' condition for options selected within the same dimension
            // e.g., (Geslacht eq 'A' or Geslacht eq 'B')
            const innerClauses = values.map(val => `${dimensionKey} eq '${val}'`).join(" or ");
            filterClauses.push(`(${innerClauses})`);
        }
    }

    // Join different dimensions with 'and'
    if (filterClauses.length > 0) {
        queryParts.push(`$filter=${filterClauses.join(" and ")}`);
    }

    return queryParts.length > 0 ? queryParts.join("&") : "";
}

async function fetchCBSTableData(tableId: string, selectedFilters: Record<string, string[]>, selectedTopics: string[]): Promise<[any, boolean]> {
	const dataProperties = await getCBSTableDataProperties(tableId);
	const dimensionKeys = dataProperties ? dataProperties
		.filter((p: any) => p["odata.type"] !== "Cbs.OData.Topic" && p["odata.type"] !== "Cbs.OData.TopicGroup")
		.map((p: any) => p.Key) : [];

	const queryString = buildODataQuery(selectedFilters, selectedTopics, dimensionKeys);
    
    // We create a helper to build the URL cleanly
    const buildUrl = (withTop: boolean) => {
        const params = [];
        if (withTop) params.push(`$top=100`);
        if (queryString) params.push(queryString);
        return `https://opendata.cbs.nl/ODataApi/OData/${tableId}/UntypedDataSet?${params.join("&")}`;
    };

    // 1. Try fetching WITHOUT top=100 first (or with it, depending on your goal)
    const url = buildUrl(false);
    console.log(`Fetching from: ${url}`);

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP: ${response.status}`);
        const data = await response.json()as any;
		console.log(`Succeeded!`)
        return [data.value, false];
    } catch (error) {
        // 2. Retry with top=100 if the first fetch fails
        console.warn("Primary fetch failed, retrying with $top=100...");
        
        const retryUrl = buildUrl(true);
        console.log(`Retrying for: ${retryUrl}`);
        
        try {
            const retryResponse = await fetch(retryUrl);
            if (!retryResponse.ok) throw new Error(`Retry HTTP: ${retryResponse.status}`);
            const retryData = await retryResponse.json() as any;


			console.log(`Succeeded after retry!`)
            return [retryData.value, true];
        } catch (retryError) {
            console.error("Critical failure on retry:", retryError);
            return [[], true];
        }
    }

}
async function getHtmlContent(context: vscode.ExtensionContext, fileName: string): Promise<string> {
    // Construct the path to your assets file
    const filePath = vscode.Uri.joinPath(context.extensionUri, 'assets', fileName);
    
    // Read file using VS Code's FS API
    const fileData = await vscode.workspace.fs.readFile(filePath);
    
    // Convert Uint8Array to string
    return new TextDecoder().decode(fileData);
};

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// This method is called when your extension is deactivated
export function deactivate() {};